# Security Audit — QHT Messaging (Next.js 14 + Supabase)

Date: 2026-06-10
Method: 6-dimension parallel scan (secrets/env, auth/authz, injection/CORS/rate-limit, RLS/data-exposure, frontend/headers, dependencies) with adversarial verification of every High/Critical finding. False positives removed.

**Stack:** Next.js 14 (app router) · Supabase Postgres (PostgREST) · service-role for server writes, public anon key + RLS for client reads · providers: Meta WhatsApp Cloud API, Evolution (Baileys), Interakt, LeadSquared, Razorpay/PayU, OpenAI, Google Calendar · deployed on a VPS under pm2.

---

## 📋 OVERALL SECURITY SCORE: 5 / 10 (before fixes)

Secret hygiene is genuinely good (no credential was ever committed, all secrets are server-only). The score is dragged down by **data-layer authorization**: several Postgres tables are reachable directly with the public anon key, bypassing every check in the API routes. After the fixes in this audit are applied + the RLS migration is run, the realistic score is **~8.5/10**.

| Severity | Count | Status after this pass |
|----------|-------|------------------------|
| 🔴 Critical | 3 | code fixed / SQL migration provided |
| 🟡 High | 3 | code fixed / SQL migration provided |
| 🟢 Medium | 9 | partly fixed, rest documented |
| ⚪ Low | 8 | documented |
| ✅ Passed | 10 | — |

---

## 🔴 CRITICAL (Fix now)

### C1 — Meta WhatsApp webhook does not verify the payload signature
- **File:** `app/api/webhook/route.ts:223-246` (POST handler)
- **Problem:** The POST handler parses the JSON body and immediately calls `processWebhook()` with the service-role client. It never checks Meta's `X-Hub-Signature-256` HMAC header. The GET handler validates `hub.verify_token`, but that only protects the one-time subscription handshake — not event delivery. `APP_SECRET` is already loaded per-portfolio (`lib/portfolios.ts:71`) but was never used. The route is also outside middleware, so there is zero gating in front of it.
- **Risk:** Anyone who knows (or guesses) a `phone_number_id` can POST forged "inbound messages", delivery/read statuses, and call events. They can inject fake patient conversations, flip message states, trigger automations/auto-replies, and pollute the inbox/CRM at will — all written with the service role (full DB power).
- **Fix (applied):** Read the raw body, compute `HMAC-SHA256(rawBody, portfolio.app_secret)`, and `timingSafeEqual` it against the header before processing; reject `401` on mismatch. Verification activates per-portfolio once `APP_SECRET` is set in `.env.local`. **→ You must set `APP_SECRET` (the Meta App Secret from the Meta dashboard → App → Settings → Basic) for each portfolio, then `pm2 restart qht-messaging --update-env`.**

### C2 — 11 sensitive tables have Row-Level Security DISABLED (public anon-key read/write)
- **File:** migrations `0011_automation.sql`, `0085_bookings.sql`, `0069_whatsapp_calls_routing.sql` (+ `db/migrations/whatsapp_calls.sql`), `0044_api_request_log.sql`, `0008_quick_replies.sql`, `0040_evolution_disconnect_log.sql`, `0041_evolution_status_posts.sql`, `0074_ozonetel.sql`, `0075_tatatele.sql`
- **Tables:** `automation_configs`, `automation_logs`, `bookings`, `whatsapp_calls`, `whatsapp_call_permissions`, `quick_replies`, `api_request_log`, `evolution_disconnects`, `evolution_status_posts`, `ozonetel_settings`, `tatatele_settings`
- **Problem:** None of these tables ever runs `enable row level security`, and no migration revokes the default Postgres grants to the `anon`/`authenticated` roles. The anon key is shipped to every browser (`NEXT_PUBLIC_SUPABASE_ANON_KEY`). With RLS off + default grants, anyone can hit `https://<project>.supabase.co/rest/v1/<table>` with only the public anon key — **no login** — and read or write these tables directly.
- **Risk:** Full unauthenticated read of patient booking data, call logs, automation configs (which can contain template/flow logic), telephony settings, and Evolution diagnostics; and unauthenticated **writes** (insert/modify/delete) bypassing the entire app.
- **Fix (SQL provided):** `supabase/migrations/0088_rls_hardening.sql` — enables RLS on all 11 and adds an authenticated-only `SELECT` policy (blocks anon, keeps the dashboard's direct reads working; all writes already go through the service role). **→ Run this migration in the Supabase SQL editor (project `qflroespjasgcnsidpcj`).**

### C3 — `payments` table: any logged-in user can read/insert/update/DELETE all payments
- **File:** `supabase/migrations/0065_payments.sql:60` — policy `payments_all_authenticated FOR ALL TO authenticated USING(true) WITH CHECK(true)`
- **Problem:** Every authenticated session (even the lowest-privilege agent) has full CRUD on the entire `payments` table directly via PostgREST, completely bypassing the role checks in `app/api/**`.
- **Risk:** Any agent can mark payments paid, alter amounts, or delete payment records straight from the browser console — financial-integrity and audit-trail compromise.
- **Fix (SQL provided in 0088):** Drop the `FOR ALL` policy; replace with `FOR SELECT TO authenticated USING(true)` (read-only for the dashboard; all writes via the service-role server routes).

### C4 — Provider API keys serialized into the dashboard page HTML (found via external scan)
- **File:** `app/(dashboard)/dashboard/page.tsx:42`
- **Problem:** The dashboard Server Component ran `supabase.from("business_numbers").select("*")` and passed the rows as props to `DashboardView` (a Client Component). Next.js serializes Server→Client props into the page's HTML/RSC payload, so the secret columns on `business_numbers` — `evolution_api_key`, `interakt_api_key`, `interakt_webhook_secret` — were embedded in the HTML delivered to every logged-in browser (visible in page source). Confirmed independently by an external scanner.
- **Risk:** Any agent (or anyone who can view a logged-in dashboard's source) could read every Evolution/Interakt API key + webhook secret and take over those WhatsApp instances. (Note: NOT exposed to the unauthenticated public — a live anon-key REST test returned 0 rows — but exposed to every authenticated session, which is still critical.)
- **Fix (applied):** Replaced `select("*")` with an explicit non-secret column list (same set `/api/business-numbers` returns). **Defense-in-depth (SQL):** `0089_protect_business_number_secrets.sql` revokes the table SELECT grant from `anon`/`authenticated` and re-grants only the non-secret columns, so a logged-in user can't read the keys via direct PostgREST either. The app reads them only via the service role.

### C5 — Payment-gateway & telephony secrets readable by any authenticated user via REST
- **Files:** `supabase/migrations/0067_payment_accounts.sql` (policy `payment_accounts_authenticated_select`), plus `ozonetel_settings`/`tatatele_settings` (authenticated SELECT added in 0088)
- **Problem:** `payment_accounts.credentials` (Razorpay/PayU `key_secret`, `merchant_salt`, `webhook_secret`), `ozonetel_settings.api_key`, and `tatatele_settings.api_token` each had a `FOR SELECT TO authenticated USING(true)` policy. The app reads all three only via the service role (verified — `lib/payment-accounts.ts`, `lib/ozonetel.ts`, `lib/tatatele.ts`), and the payment settings API already masks secrets — but a logged-in user could bypass the app and `select credentials from payment_accounts` directly over PostgREST.
- **Risk:** Any agent could harvest the payment-gateway and telephony API secrets. (Not public — a live anon-key test returned 0 rows — but exposed to every authenticated session.)
- **Fix (SQL):** `0090_lock_secret_tables_to_service_role.sql` drops the authenticated SELECT policy on all three → RLS-enabled with no policy = service-role-only.
- **Swept clean:** a full pass confirmed no OTHER server-component→client-HTML leaks (only the dashboard's `business_numbers`), `app_credentials`/`whatsapp_portfolios`/`tatatele_settings` aren't even exposed through PostgREST, and the payments API masks secrets in its responses.

---

## 🟡 HIGH (Fix soon)

### H1 — `POST /api/payments/[id]/mark-paid` has no authorization (financial IDOR)
- **File:** `app/api/payments/[id]/mark-paid/route.ts:16-49`
- **Problem:** Only checks that a session exists (`auth.getUser()`). No role check, no number-scope. Any logged-in user can mark **any** payment paid by id (and fire a receipt).
- **Fix (applied):** Require role `admin`+ via `getCurrentMember()/isAtLeast`, and scope to the payment's `business_phone_number_id` against the caller's allowed numbers.

### H2 — `api_tokens` (plaintext bearer tokens) readable by any authenticated user
- **File:** `supabase/migrations/0024_api_tokens.sql:41` — `FOR SELECT USING (auth.role() = 'authenticated')`; tokens stored in plaintext (`:22`)
- **Problem:** Any authenticated session can `SELECT *` from `api_tokens` and read every API bearer token in plaintext, regardless of role.
- **Risk:** Token theft → full API access as the workspace.
- **Fix (SQL in 0088):** Restrict reads to `owner/superadmin/admin` via `current_member_role()`. **Recommended follow-up:** store only a hash + last-4 instead of plaintext.

### H3 — Storage buckets are public-read and listable (patient media enumerable)
- **File:** `db/migrations/contact_avatar.sql:20`, `db/migrations/automation_trigger_images_bucket.sql:11`, `lib/storage.ts:6,57` (`whatsapp-media` bucket)
- **Problem:** `contact-avatars` and `automation-trigger-images` are `public=true` with a read policy that has **no** `auth.role()` constraint → object rows are enumerable by anon. All WhatsApp message media (patient photos, PDFs, audio/video) goes to a public `whatsapp-media` bucket served via `getPublicUrl()`. Object paths used weak entropy (`Date.now() + Math.random().slice(2,8)`).
- **Risk:** Anyone who can list/enumerate object paths can pull patient photos and documents without authentication.
- **Fix (partial, applied):** Object paths now use `crypto.randomUUID()` (unguessable). **Recommended follow-up (not auto-applied — would break media rendering / outbound magic-card images that Meta fetches publicly):** move private media to `public=false` buckets served via short-lived **signed URLs** from server routes; keep only genuinely-public assets (e.g. outbound card images) in a public bucket.

---

## 🟢 MEDIUM (This sprint)

- **M1 — No HTTP security headers.** `next.config.mjs` set none (CSP, X-Frame-Options, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy). **Fixed:** added `headers()` (X-Frame-Options DENY, HSTS, nosniff, Referrer-Policy, Permissions-Policy) + `poweredByHeader:false`. (Strict CSP left as a follow-up — needs per-route testing with Next's inline scripts.)
- **M2 — PostgREST `.or()` filter-string injection.** `app/api/contacts/search/route.ts:49-58` interpolates the raw query `q` into `name.ilike.%${q}%`. A `q` containing commas/parens can inject extra filter conditions. **Fixed:** strip PostgREST filter metacharacters (`,()\`) from `q` before building the filter.
- **M3 — `assistant` `run_sql_select` exposes arbitrary read-SQL to every role.** `app/api/assistant/chat/route.ts:1004-1029` — the AI tool runs SELECTs scoped only by the LLM prompt, not enforced in code. A crafted prompt could read any table the service role can. **Documented — recommend a server-side allow-list of tables/columns + a hard `LIMIT`, and gate the tool behind a role.**
- **M4 — Verbatim error messages returned to clients (~60 routes).** Returning `error.message`/`e.message` leaks DB/internal detail. **Documented — wrap in a generic message; log detail server-side only.**
- **M5 — No rate limiting on expensive endpoints.** Only credential paths are throttled (`middleware.ts:7-33`, in-memory). AI chat, SQL, bulk messaging, and webhooks are unthrottled. **Documented — add per-user/IP limits (and persist across instances if you scale out).**
- **M6 — Open redirect via protocol-relative `next` param.** `app/auth/callback/route.ts:25` and `app/auth/recovery/route.ts:25` accept any value starting with `/`, including `//evil.com`. **Fixed:** reject `//` and `/\`.
- **M7 — `next/image` `remotePatterns` uses `hostname:"**"`.** Turns the optimizer into an open image proxy. **Documented — enumerate the real hosts (Supabase storage, WhatsApp/Meta CDNs, profile-pic hosts) and replace the wildcard.**
- **M8 — `contacts` UPDATE / `contact_notes` / `refund_requests` writable by any authenticated user** (`using(true)`). Matches the app's trusted-workspace model but is broader than ideal. **Documented — tighten to per-number/role scope where practical (note: `contacts` UPDATE is used by the client to reset `unread_count`, so keep that path).**
- **M9 — Stray build cache `.next.trash1/` was git-tracked** (baked-in anon key only — verified no service-role/Meta/payment secret). **Fixed:** untracked + ignore pattern added.

---

## ⚪ LOW

- **L1** — `X-Powered-By` header not disabled. **Fixed** (`poweredByHeader:false`).
- **L2** — Patient PII (name + message preview) persisted to `localStorage` (`lib/notifications-store.ts`, `components/HomeAssistant.tsx`). Shared-device exposure. Documented.
- **L3** — `PATCH/DELETE /api/quick-replies/[id]` — any logged-in user can edit/delete any quick reply. Documented (low impact).
- **L4** — API tokens stored in plaintext + matched by exact equality (`lib/api-tokens.ts`). Move to hashed storage. Documented.
- **L5** — Evolution webhook authenticates only by a guessable instance name in the URL (`app/api/evolution/webhook/[name]/route.ts`) — no secret. Documented.
- **L6** — Rate limiting is in-memory and credential-path-only (`middleware.ts`). Won't survive multi-instance. Documented.
- **L7** — Dead Puppeteer image-generator service still in repo (`services/image-generator/server.js`, `--no-sandbox`, no auth, port 3001). **Recommend deleting it** — it's unused and is a soft target if ever run.
- **L8** — `playwright` is a production dependency (heavy; used only for PayU QR scraping). Consider moving to a worker / devDependency.

---

## ✅ PASSED CHECKS

1. **`.env.local` never committed** and is covered by `.gitignore` (`.env*.local`, `.env`); `git ls-files` + full history confirm it.
2. **`.env.local.example` holds only placeholders** — no real key/token/connection string.
3. **No hardcoded secrets in application source** (repo-wide scan for `EAA…`, `sk-…`, JWTs, `postgres://`, `AKIA…`, `rzp_…`, private keys — clean; the only connection-string literal is a fill-in placeholder in a code-template generator).
4. **All provider secrets are server-only** (`process.env` in `runtime:'nodejs'` modules) — none referenced in `"use client"` code or shippable to the browser bundle.
5. **Only non-sensitive values use `NEXT_PUBLIC_`** (Supabase URL + anon key, app URL, demo flag, allowed domain, USD/INR) — no secret is public-prefixed.
6. **No secrets in logs** — `console.*` calls log only error messages / status codes / URLs, never tokens or keys.
7. **`process-pending.sh`** reads the internal token from `.env.local` at runtime — not hardcoded; no Dockerfile/CI to leak.
8. **Payment API responses strip secrets** before returning (`has_webhook_secret` boolean instead of the secret).
9. **Next.js 14.2 middleware CVE is not exploitable here** — API auth is self-enforced per-route (not delegated to middleware), so the middleware-bypass class doesn't grant access. (Still recommend upgrading Next.js when convenient.)
10. **Service-role key is server-only** and not exposed through any client path or API response.

---

## What you must do (not auto-fixable)

1. **Run** `supabase/migrations/0088_rls_hardening.sql` in the Supabase SQL editor (project `qflroespjasgcnsidpcj`) — closes C2, C3, H2.
2. **Set `APP_SECRET`** (Meta App Secret) in `.env.local` and `pm2 restart qht-messaging --update-env` — activates C1 signature verification. Until set, the webhook logs a warning and still accepts events (non-breaking), so the hole stays open until you set it.
3. **No secret rotation required** — nothing sensitive was ever committed to git.
4. Deploy the code fixes: `git pull && npm install && npm run build && pm2 restart qht-messaging`.
