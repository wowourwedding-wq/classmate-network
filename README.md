# ClassMate School Network

Cloudflare Worker backend powering cross-school library sharing for **ClassMate Zim**, **SA**, and **Zambia**. Schools register, get a unique 8-char code, and can upload papers + browse others' uploads within the same country (or globally).

## Architecture

```
ClassMate apps (Zim/SA/Zambia)
       │
       ▼ X-School-Code header
┌────────────────────────────────────────┐
│  classmate-network.workers.dev         │
│  ─ POST /api/schools/register          │
│  ─ POST /api/papers/upload (multipart) │
│  ─ GET  /api/papers/feed?country=...   │
│  ─ GET  /api/papers/:id  (returns PDF) │
│  ─ POST /api/papers/:id/flag           │
│  ─ POST /api/admin/moderate  (admin)   │
│  ─ GET  /api/admin/queue     (admin)   │
└────────────────────────────────────────┘
        │            │
        ▼            ▼
       D1           R2
   (metadata)   (PDF files)
```

## Setup (one-time, ~10 minutes)

You must do these **once** before the worker can deploy successfully.

### 1. Create D1 database
**Via Cloudflare dashboard:**
1. https://dash.cloudflare.com/ → **Workers & Pages** → **D1**
2. Click **Create database** → name it `classmate-network-db` → **Create**
3. Copy the **Database ID** (looks like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)
4. Edit `wrangler.jsonc` in this repo → replace `REPLACE_WITH_D1_ID_AFTER_CREATING` with the ID
5. Commit the change

### 2. Run the schema migration
**Via dashboard:** open `classmate-network-db` → **Console** tab → paste contents of `schema.sql` → **Execute**

Or if you have wrangler CLI locally:
```
wrangler d1 execute classmate-network-db --file=schema.sql --remote
```

### 3. Create R2 bucket
1. https://dash.cloudflare.com/ → **R2 Object Storage** → **Create bucket**
2. Name it `classmate-network-papers` → **Create bucket**
3. (Already configured in `wrangler.jsonc` by name — no ID swap needed.)

### 4. Set admin PIN secret
1. **Workers & Pages** → `classmate-network` → **Settings** → **Variables and Secrets**
2. Add a new **Secret** named `ADMIN_PIN` with a strong PIN of your choice (you'll use this to approve papers)

### 5. Add GitHub secrets for auto-deploy
1. https://github.com/wowourwedding-wq/classmate-network/settings/secrets/actions
2. Add `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (same values as your other ClassMate repos)
3. Push any commit to trigger the first deploy (or run the workflow manually)

## API quick test (once deployed)

Health check:
```
curl https://classmate-network.<your-subdomain>.workers.dev/
```

Register a test school:
```
curl -X POST https://classmate-network.<your-subdomain>.workers.dev/api/schools/register \
  -H "content-type: application/json" \
  -d '{"name":"Test High","country":"ZW"}'
```

Returned `code` is what teachers paste into ClassMate Settings → School Code.

## Visibility rules

| Visibility | Who can see |
|---|---|
| `private` | Only the uploading school |
| `country` (default) | Any school in the same country |
| `network` | Any subscribed school worldwide |

## Moderation flow

- New school's first 5 papers → `pending` (admin approves via `/api/admin/moderate`)
- After 5 approvals → school's `trust_level` becomes 1 → uploads auto-approve
- Anyone can flag (`POST /api/papers/:id/flag`) → after 3 flags, paper re-enters `pending`

## Costs at scale

- **Workers free tier**: 100K requests/day
- **D1 free tier**: 5M reads/day, 100K writes/day
- **R2 free tier**: 10GB storage, **zero egress fees**

At 100 schools × 50 papers × 2MB avg = ~10GB storage = **$0/month**.
At 1000 schools = ~100GB = ~$1.50/month.
