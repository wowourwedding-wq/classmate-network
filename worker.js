/* ClassMate School Network — Cloudflare Worker (backend).
   One-file Worker. Endpoints under /api/*. Uses D1 (SQL) for metadata + R2
   (object storage) for the actual PDF binaries.

   Endpoints:
     POST /api/schools/register   — create school, return school code
     POST /api/papers/upload      — upload a paper (multipart form)
     GET  /api/papers/feed        — list papers visible to a school code
     GET  /api/papers/:id         — fetch a paper PDF (auth-checked)
     POST /api/papers/:id/flag    — flag for re-moderation
     POST /api/admin/moderate     — admin approve/reject (needs ADMIN_PIN env)
     GET  /api/admin/queue        — list pending papers (admin only)
     GET  /                       — health check

   Authentication model:
     - School code (8 chars, e.g. "ZW-7K3M") = the access ticket.
     - Teachers sign in with their school code via the ClassMate app.
     - No accounts, no passwords — code-based access keeps friction low.
     - Admin endpoints require X-Admin-Pin header matching ADMIN_PIN env secret.

   Moderation:
     - New schools: trust_level=0. Their uploads default mod_status='pending'.
     - After their 5th approval, trust_level becomes 1 (auto-approve).
     - Anyone can flag a paper → re-enters mod queue if flag_count >= 3.
*/

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-School-Code, X-Admin-Pin',
  'Access-Control-Max-Age': '86400'
};

const COUNTRY_CODES = new Set(['ZW', 'ZA', 'ZM']);  // expand as we add editions
const SCHOOL_CODE_RE = /^[A-Z]{2}-[A-Z0-9]{4,8}$/;

// ===== Helpers =====
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...extraHeaders }
  });
}
function err(status, message) { return json({ error: message }, status); }

function uuid() {
  // RFC-4122 v4 via crypto
  return crypto.randomUUID();
}

function genSchoolCode(countryCode) {
  // 4-char random suffix, base32-ish (no ambiguous chars)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${countryCode}-${suffix}`;
}

async function getSchoolByCode(env, code) {
  if (!code || !SCHOOL_CODE_RE.test(code)) return null;
  const row = await env.DB.prepare('SELECT * FROM schools WHERE code = ?').bind(code).first();
  return row || null;
}

function requireSchool(request, env) {
  const code = request.headers.get('X-School-Code');
  return getSchoolByCode(env, code);
}

function requireAdmin(request, env) {
  const pin = request.headers.get('X-Admin-Pin');
  return pin && env.ADMIN_PIN && pin === env.ADMIN_PIN;
}

// ===== Routes =====

// POST /api/schools/register
//   body: { name, country, contact_email?, contact_phone? }
//   returns: { school: {...}, code: 'ZW-XYZ4' }
async function handleRegister(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.name || !body.country) return err(400, 'Missing name or country');
  if (!COUNTRY_CODES.has(body.country)) return err(400, 'Country must be ZW, ZA, or ZM');

  // Generate a unique school code (retry on collision, max 5 tries)
  let code = null;
  for (let i = 0; i < 5; i++) {
    const candidate = genSchoolCode(body.country);
    const existing = await env.DB.prepare('SELECT id FROM schools WHERE code = ?').bind(candidate).first();
    if (!existing) { code = candidate; break; }
  }
  if (!code) return err(500, 'Could not generate unique school code');

  const id = uuid();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO schools (id, code, name, country, contact_email, contact_phone, plan, upload_count, trust_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)'
  ).bind(id, code, body.name, body.country, body.contact_email || null, body.contact_phone || null, body.plan || 'free', now).run();

  return json({
    school: { id, code, name: body.name, country: body.country, plan: body.plan || 'free' },
    message: 'School registered. Share this code with your teachers so they can connect: ' + code
  }, 201);
}

// POST /api/papers/upload
//   headers: X-School-Code
//   body: multipart/form-data with file + JSON metadata
//   returns: { paper: {...}, mod_status: 'pending'|'approved' }
async function handleUpload(request, env) {
  const school = await requireSchool(request, env);
  if (!school) return err(401, 'Invalid or missing school code');

  const form = await request.formData().catch(() => null);
  if (!form) return err(400, 'Expected multipart/form-data');

  const file = form.get('file');
  if (!file || !(file instanceof File)) return err(400, 'Missing file');
  if (file.size > 25 * 1024 * 1024) return err(413, 'File too large (max 25 MB)');
  if (file.type && !['application/pdf', 'application/octet-stream'].includes(file.type)) {
    return err(415, 'Only PDF files accepted');
  }

  const title = (form.get('title') || file.name || 'Untitled').toString().slice(0, 200);
  const subject = (form.get('subject') || '').toString().slice(0, 100);
  const level = (form.get('level') || '').toString().slice(0, 50);
  const grade = (form.get('grade') || '').toString().slice(0, 50);
  const year = (form.get('year') || '').toString().slice(0, 10);
  const paperNumber = (form.get('paper_number') || '').toString().slice(0, 50);
  const curriculum = (form.get('curriculum') || '').toString().slice(0, 30);
  const visibility = ['private', 'country', 'network'].includes(form.get('visibility'))
    ? form.get('visibility') : 'country';

  // Upload to R2
  const paperId = uuid();
  const r2Key = `papers/${school.country}/${paperId}.pdf`;
  await env.R2.put(r2Key, file.stream(), {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { school_id: school.id, title }
  });

  // Mod status: pending if trust=0, approved if trust>=1
  const modStatus = school.trust_level >= 1 ? 'approved' : 'pending';

  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO papers (id, school_id, title, subject, level, grade, year, paper_number, curriculum, country, r2_key, file_size, content_type, visibility, mod_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(paperId, school.id, title, subject, level, grade, year, paperNumber, curriculum, school.country, r2Key, file.size, file.type || 'application/pdf', visibility, modStatus, now).run();

  await env.DB.prepare('UPDATE schools SET upload_count = upload_count + 1 WHERE id = ?').bind(school.id).run();

  return json({
    paper: { id: paperId, title, subject, level, grade, visibility, mod_status: modStatus },
    message: modStatus === 'pending'
      ? 'Uploaded — waiting for moderation approval before others can see it.'
      : 'Uploaded — live on the shared library now.'
  }, 201);
}

// GET /api/papers/feed?country=ZW&subject=Mathematics&level=olevel&grade=grade12&q=algebra
//   headers: X-School-Code
//   returns: { papers: [...], total }
async function handleFeed(request, env) {
  const school = await requireSchool(request, env);
  if (!school) return err(401, 'Invalid or missing school code');

  const url = new URL(request.url);
  const country = url.searchParams.get('country') || school.country;
  const subject = url.searchParams.get('subject');
  const level = url.searchParams.get('level');
  const grade = url.searchParams.get('grade');
  const q = url.searchParams.get('q');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

  // Visibility rules: school sees their own private + country-visible from same country + network-visible from anywhere.
  // All column refs qualified with p. because `country` exists in both papers and schools tables.
  let where = `p.mod_status = 'approved' AND (
    p.school_id = ? OR
    (p.visibility = 'country' AND p.country = ?) OR
    p.visibility = 'network'
  )`;
  const params = [school.id, country];

  if (subject) { where += ' AND p.subject = ?'; params.push(subject); }
  if (level)   { where += ' AND p.level = ?';   params.push(level); }
  if (grade)   { where += ' AND p.grade = ?';   params.push(grade); }
  if (q) {
    where += ' AND (p.title LIKE ? OR p.subject LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }

  const rs = await env.DB.prepare(
    `SELECT p.id, p.title, p.subject, p.level, p.grade, p.year, p.paper_number, p.curriculum, p.country, p.visibility, p.file_size, p.download_count, p.created_at,
            s.name AS school_name
       FROM papers p
       JOIN schools s ON s.id = p.school_id
      WHERE ${where}
      ORDER BY p.created_at DESC
      LIMIT ?`
  ).bind(...params, limit).all();

  return json({ papers: rs.results || [], total: (rs.results || []).length });
}

// GET /api/papers/:id
//   headers: X-School-Code
//   returns: PDF binary
async function handleFetchPaper(request, env, paperId) {
  const school = await requireSchool(request, env);
  if (!school) return err(401, 'Invalid or missing school code');

  const paper = await env.DB.prepare('SELECT * FROM papers WHERE id = ?').bind(paperId).first();
  if (!paper) return err(404, 'Paper not found');
  if (paper.mod_status !== 'approved' && paper.school_id !== school.id) return err(403, 'Not yet approved');

  // Visibility check
  const visible = paper.school_id === school.id
    || (paper.visibility === 'country' && paper.country === school.country)
    || paper.visibility === 'network';
  if (!visible) return err(403, 'Not visible to your school');

  const obj = await env.R2.get(paper.r2_key);
  if (!obj) return err(410, 'File gone');

  await env.DB.prepare('UPDATE papers SET download_count = download_count + 1 WHERE id = ?').bind(paperId).run();

  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': paper.content_type || 'application/pdf',
      'content-disposition': `inline; filename="${(paper.title || 'paper').replace(/[^A-Za-z0-9._-]/g, '_')}.pdf"`,
      'cache-control': 'public, max-age=2592000, immutable',
      ...CORS_HEADERS
    }
  });
}

// POST /api/papers/:id/flag
//   headers: X-School-Code
//   body: { reason }
async function handleFlag(request, env, paperId) {
  const school = await requireSchool(request, env);
  if (!school) return err(401, 'Invalid or missing school code');

  const body = await request.json().catch(() => ({}));
  await env.DB.prepare(
    'INSERT INTO flags (id, paper_id, flagged_by, reason, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(uuid(), paperId, school.id, (body.reason || '').slice(0, 500), Date.now()).run();

  // Increment flag count; if >= 3, re-moderate
  await env.DB.prepare('UPDATE papers SET flag_count = flag_count + 1 WHERE id = ?').bind(paperId).run();
  await env.DB.prepare(
    "UPDATE papers SET mod_status = 'pending' WHERE id = ? AND flag_count >= 3"
  ).bind(paperId).run();

  return json({ message: 'Reported. Thank you — our moderators will review.' });
}

// POST /api/admin/moderate
//   headers: X-Admin-Pin
//   body: { paper_id, action: 'approve'|'reject', reason? }
async function handleAdminModerate(request, env) {
  if (!requireAdmin(request, env)) return err(401, 'Admin pin required');
  const body = await request.json().catch(() => null);
  if (!body || !body.paper_id || !['approve','reject'].includes(body.action)) return err(400, 'Need paper_id + action');

  const newStatus = body.action === 'approve' ? 'approved' : 'rejected';
  await env.DB.prepare('UPDATE papers SET mod_status = ?, mod_reason = ? WHERE id = ?')
    .bind(newStatus, body.reason || null, body.paper_id).run();

  // If approving, count toward school's trust level
  if (body.action === 'approve') {
    const paper = await env.DB.prepare('SELECT school_id FROM papers WHERE id = ?').bind(body.paper_id).first();
    if (paper) {
      const approvedCount = await env.DB.prepare(
        "SELECT COUNT(*) as n FROM papers WHERE school_id = ? AND mod_status = 'approved'"
      ).bind(paper.school_id).first();
      if (approvedCount && approvedCount.n >= 5) {
        await env.DB.prepare('UPDATE schools SET trust_level = 1 WHERE id = ?').bind(paper.school_id).run();
      }
    }
  }

  return json({ message: `Paper ${newStatus}` });
}

// GET /api/admin/queue
//   headers: X-Admin-Pin
async function handleAdminQueue(request, env) {
  if (!requireAdmin(request, env)) return err(401, 'Admin pin required');
  const rs = await env.DB.prepare(
    `SELECT p.id, p.title, p.subject, p.level, p.country, p.flag_count, p.created_at, s.name AS school_name, s.code AS school_code
       FROM papers p
       JOIN schools s ON s.id = p.school_id
      WHERE p.mod_status = 'pending'
      ORDER BY p.created_at ASC
      LIMIT 100`
  ).all();
  return json({ pending: rs.results || [] });
}

// ===== Router =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      // Health check
      if (path === '/' || path === '/api') {
        return json({ status: 'ok', service: 'classmate-network', version: '1.0.0' });
      }
      // Routes
      if (path === '/api/schools/register' && method === 'POST') return handleRegister(request, env);
      if (path === '/api/papers/upload'    && method === 'POST') return handleUpload(request, env);
      if (path === '/api/papers/feed'      && method === 'GET')  return handleFeed(request, env);
      if (path === '/api/admin/moderate'   && method === 'POST') return handleAdminModerate(request, env);
      if (path === '/api/admin/queue'      && method === 'GET')  return handleAdminQueue(request, env);

      // /api/papers/:id and /api/papers/:id/flag
      const paperMatch = path.match(/^\/api\/papers\/([a-f0-9-]+)(\/flag)?$/);
      if (paperMatch) {
        const paperId = paperMatch[1];
        if (paperMatch[2] === '/flag' && method === 'POST') return handleFlag(request, env, paperId);
        if (!paperMatch[2] && method === 'GET') return handleFetchPaper(request, env, paperId);
      }

      return err(404, 'Not Found');
    } catch (e) {
      return err(500, e.message || 'Internal Server Error');
    }
  }
};
