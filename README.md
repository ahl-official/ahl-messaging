# QHT WhatsApp Dashboard

Internal messaging dashboard for QHT Clinic — a WhatsApp Web–style UI on top of Meta's WhatsApp Cloud API and Supabase.

## Stack

- **Next.js 14** (App Router) + TypeScript + Tailwind + hand-rolled shadcn/ui primitives
- **Supabase** (Postgres + Realtime + Auth)
- **Meta WhatsApp Cloud API** (Graph v21.0)
- Vercel-ready

## What you get

- 🔐 Email/password auth (Supabase). `/dashboard` is protected by middleware.
- 📥 Inbound messages arrive via webhook, persist to Postgres, and stream to the UI in realtime.
- 📤 Outbound messages go through `/api/send-message` (Cloud API + DB write).
- 💬 WhatsApp-Web layout: contact list + chat pane + status ticks (✓ / ✓✓ / read).
- 🔍 Search, unread badges, date separators, optimistic send with failure recovery.

---

## 1. Local setup

```bash
npm install
cp .env.local.example .env.local         # fill in real values
npm run dev                               # http://localhost:3000
```

You'll be redirected to `/login`. Without env values the app boots but every Supabase call fails — finish step 2 first.

## 2. Supabase

1. Create a project at <https://supabase.com>.
2. **Project Settings → API** → copy:
   - `Project URL`               → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key           → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key (secret) → `SUPABASE_SERVICE_ROLE_KEY`
3. **SQL editor** → paste & run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql). It is idempotent.
4. **Authentication → Users → Add user** → email + password. This is your dashboard login.
5. **Authentication → Providers → Email** → turn off "Confirm email" for the admin user (or confirm the email manually).

## 3. Meta WhatsApp Cloud API

1. <https://developers.facebook.com> → create an app → add the **WhatsApp** product.
2. From the WhatsApp dashboard copy:
   - **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`
   - Generate a **System User permanent token** with `whatsapp_business_messaging` + `whatsapp_business_management` scopes → `WHATSAPP_ACCESS_TOKEN`
3. Add a verified test recipient phone number (or move the app to Live).

### Webhook configuration

```bash
ngrok http 3000
# copy the https URL, e.g. https://abc-12-34.ngrok.app
```

In Meta dashboard → **WhatsApp → Configuration → Webhook → Edit**:

| Field           | Value                                                |
| --------------- | ---------------------------------------------------- |
| Callback URL    | `https://<ngrok-id>.ngrok.app/api/webhook`           |
| Verify token    | value of `WHATSAPP_VERIFY_TOKEN` (default `qht_clinic_verify_2026`) |
| Subscribe to    | `messages` (and optionally `message_status`)         |

Hit **Verify and save** — Meta makes a `GET` to your webhook with `hub.verify_token`. The route returns the `hub.challenge` if the token matches.

---

## 4. Test

### Verify the webhook locally

```bash
curl -i "http://localhost:3000/api/webhook?hub.mode=subscribe&hub.verify_token=qht_clinic_verify_2026&hub.challenge=hello123"
# → 200 with body: hello123
```

### Send a test message

```bash
# 1) Sign in to /login in the browser so you have a session cookie
# 2) Then in DevTools → Application → Cookies, copy the sb-* cookies into curl,
#    or just use the dashboard UI to send.

# Direct API call (replace COOKIE with your sb-... cookies):
curl -X POST http://localhost:3000/api/send-message \
  -H "Content-Type: application/json" \
  -H "Cookie: <your sb-* cookies>" \
  -d '{"wa_id":"919876543210","text":"Hello from QHT!"}'
```

The response is `{ "message": { ...inserted row... } }`. Open `/dashboard` — the new contact appears in the sidebar and the message bubble shows in the chat pane.

### Inbound flow

Send a WhatsApp message **to** your business number from a permitted phone. Within ~1s it should appear in the dashboard with an unread badge.

---

## 5. Project layout

```
app/
├── (auth)/login/                login page + signIn/signOut server actions
├── (dashboard)/
│   ├── layout.tsx               header + logout + auth gate
│   └── dashboard/page.tsx       loads contacts → <DashboardView/>
├── api/
│   ├── webhook/route.ts         GET verify + POST receive (service-role writes)
│   └── send-message/route.ts    auth-gated, calls Meta + persists
├── layout.tsx · globals.css · page.tsx (redirects /)
components/
├── ContactList.tsx              search, realtime, unread, last-message preview
├── ChatWindow.tsx               fetch + realtime, day separators, optimistic send
├── MessageBubble.tsx            in/out, timestamp, status ticks
├── MessageInput.tsx             Enter-to-send, Shift+Enter newline
├── DashboardView.tsx            holds selected contact (mobile-aware split)
└── ui/                          button · input · textarea · badge · avatar · scroll-area
lib/
├── supabase/{client,server,middleware}.ts
├── whatsapp.ts                  sendTextMessage / sendTemplate / sendMedia
├── types.ts                     Contact + Message + display helpers
└── utils.ts                     cn(), formatRelativeTime()
middleware.ts                    refreshes session + gates /dashboard
supabase/migrations/0001_init.sql
```

---

## 6. Security notes

- `SUPABASE_SERVICE_ROLE_KEY` is **server-only** — never prefix it with `NEXT_PUBLIC_` and never import it from a client component.
- The webhook responds `200` even on internal errors so Meta doesn't retry-storm; errors are logged server-side. **Tokens and full PII payloads are never logged**, only short error messages.
- RLS is on for both tables. The UI reads with the anon key + a logged-in session; all writes go through the service-role key on the server (webhook + send-message).
- The webhook deduplicates on `wa_message_id` (Postgres unique constraint), so Meta retries are idempotent.

## 7. Deployment

- Push to GitHub → import in Vercel → add the same env vars.
- Update the Meta webhook URL to your Vercel domain (no more ngrok).
- For the WhatsApp business number you'll need to move the Meta app from **Development** to **Live**.
