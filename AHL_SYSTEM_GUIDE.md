# AHL Messaging — System Guide

**American Hairline / Alchemane**  
**Production URL:** https://wa.hairscalptradingco.com  
**Last updated:** July 2026

This guide explains what the AHL Messaging platform is, how every major feature works, and how to set it up and run it day to day. It is written for business owners and team leads — not developers.

---

## Section 1 — What Is This System?

### The problem it solves

Your sales and service teams talk to customers on WhatsApp every day. Without a central system, conversations are scattered across personal phones, spreadsheets, and separate CRM tools. Managers cannot see who replied, which leads are waiting, or whether follow-ups happened on time.

**AHL Messaging** is a single web dashboard where your whole team reads and replies to WhatsApp messages, uses AI to speed up responses, runs campaigns, collects payments, logs calls, and syncs with your CRM — all from one place.

### What it replaces

- Personal WhatsApp on staff phones for business chats
- Manual copy-paste between WhatsApp and a CRM
- Separate bulk-sending tools
- Ad-hoc spreadsheets for lead assignment
- One-off payment links sent from personal UPI apps without tracking

### Core value (in plain language)

1. **One inbox for the whole team** — every business WhatsApp number feeds into the same system. Agents see only what they are allowed to see.
2. **Faster replies with AI** — an AI assistant can draft or auto-send replies trained on your SOPs and FAQs, while humans take over when needed.
3. **Campaigns at scale** — send approved WhatsApp templates or AI-written messages to thousands of contacts with scheduling and unsubscribe handling.
4. **Money in the chat** — send Razorpay or PayU payment links without leaving the conversation.
5. **CRM connected** — LeadSquared (or your future CRM) stays in sync: stages, owners, notes, and activities update automatically.
6. **Accountability** — reports show who replied, how fast, and whether daily targets were met.

---

## Section 2 — Complete Feature List

### Home dashboard

**What it does:** Gives a morning snapshot — open conversations, unread counts per WhatsApp number, recent activity, and chats that may expire under Meta’s 24-hour window.

**Where to find it:** Left sidebar → **Home** (`/home`).

---

### WhatsApp Inbox

**What it does:** The main workspace. Contact list on the left, chat in the centre, customer details on the right. Supports text, images, voice notes, documents, templates, quick replies, reactions, and read receipts. Real-time updates when new messages arrive.

**Where to find it:** Left sidebar → **Inbox** (`/dashboard`).

---

### Bird’s Eye view

**What it does:** Shows multiple agents’ inboxes side by side so supervisors can monitor live conversations without taking them over.

**Where to find it:** Left sidebar → **Bird’s Eye** (`/bird-eye`). Requires inbox access.

---

### Contacts hub

**What it does:** Searchable list of all customers across numbers — filter by label, assignment, stage, or tags. Useful for managers auditing the database.

**Where to find it:** Left sidebar → **Contacts** (`/contacts`).

---

### Contact side panel (in Inbox)

**What it does:** When you open a chat, the right panel shows CRM lead info, funnel stage, labels, internal notes, photos, package details, AI summary, suggested reply, payment history, refund requests, and tasks linked to that customer.

**Where to find it:** Open any chat in Inbox — panel on the right.

---

### AI assist in composer

**What it does:** Sparkle button on text fields helps operators generate personas, prompts, campaign briefs, and knowledge chunks. Separate **AHL AI** section in the contact panel offers chat summary and suggested reply.

**Where to find it:** Automation settings, campaign wizard, contact panel → **AHL AI**.

---

### Magic Message

**What it does:** Operator-triggered AI that generates a polished text or image card (e.g. offer graphic) to send in one tap.

**Where to find it:** Chat toolbar in Inbox (magic wand icon).

---

### Spell-correct / professional rewrite

**What it does:** Turns a rough draft into clear, professional English before sending.

**Where to find it:** Composer toolbar in Inbox.

---

### Quick Replies

**What it does:** Saved canned responses per WhatsApp number — text, media, or button templates agents insert with one click.

**Where to find it:** Left sidebar → **Quick Replies** (`/quick-replies`).

---

### WhatsApp Templates

**What it does:** Create, edit, and submit Meta-approved message templates for outbound campaigns and notifications outside the 24-hour window.

**Where to find it:** Left sidebar → **Templates** (`/templates`).

---

### Campaigns

**What it does:** Bulk sends using approved templates or AI “magic” messages. Supports scheduling, audience filters, drip sequences tied to CRM stages, and recurring daily campaigns. Tracks delivery, read, and reply stats.

**Where to find it:** Left sidebar → **Campaigns** (`/campaigns`). Admin role required.

---

### Automation (AI auto-reply)

**What it does:** Per-number AI configuration — system prompt, model choice, knowledge base (RAG), human-takeover rules, reply delay, image handling, LSQ field extraction, and visual trigger flows (keyword → action chains).

**Where to find it:** Left sidebar → **Automation** (`/automation`).

---

### Lead Distribution

**What it does:** Round-robin assignment of new leads to sales agents by CRM stage, brand, or group. Includes daily reset rules and LSQ stage-triggered automations (e.g. send template when stage changes).

**Where to find it:** Left sidebar → **Lead Distribution** (`/lead-distribution`).

---

### LeadSquared integration

**What it does:** Two-way sync with LeadSquared CRM — create/update leads, log WhatsApp activities, backfill missing leads, webhook ingest, stage counts for the funnel strip, nightly sync, and push-failure retry queue.

**Where to find it:** Left sidebar → **LeadSquared** (`/integrations/lsq`).

---

### Telephony

**What it does:** Click-to-call from the dashboard via Ozonetel or Tata Tele. Universal webhook connector for other phone systems. Call history merges WhatsApp voice calls and PSTN calls.

**Where to find it:** Left sidebar → **Telephony** (`/integrations/telephony`). Call widget appears globally when configured.

---

### WhatsApp Calling (WebRTC)

**What it does:** Accept and make voice calls through Meta’s official WhatsApp Calling API directly in the browser.

**Where to find it:** Global call overlay when an inbound call arrives; initiate from chat when enabled.

---

### Call history

**What it does:** Log of all calls — WhatsApp and telephony — with duration, direction, and optional transcription.

**Where to find it:** Left sidebar → **Call history** (`/calls`).

---

### Payments

**What it does:** Send Razorpay payment links or PayU UPI QR codes from the chat composer. Webhooks update payment status. Tax invoices can be generated. Separate accounts for American Hairline and Alchemane brands.

**Where to find it:** Composer ₹ button in Inbox; Settings → **Payments** for account setup.

---

### Booking / Date Align

**What it does:** Send a booking link that lets customers pick an appointment slot from your Google Calendar. Public booking page at `/book/[token]`.

**Where to find it:** Composer when **Date Align** capability is enabled on the number.

---

### Tasks

**What it does:** Internal task board with comments — assign follow-ups to team members linked to customers.

**Where to find it:** Left sidebar → **Tasks** (`/tasks`).

---

### Reports

**What it does:** Analytics dashboard (message volume, response times, campaign performance) and agent productivity (replies per day, KRA vs target).

**Where to find it:** Left sidebar → **Reports** (`/reports`). Admin or team lead.

---

### Team KRA / Targets

**What it does:** Set daily reply targets per role or per individual agent. Team leads get a shortcut view.

**Where to find it:** Settings → **Targets** (`/settings/targets`) or Team KRA link for leads.

---

### Settings hub

**What it does:** Central place for team, numbers, permissions, labels, capabilities, portfolios, API tokens, data import/export, AI globals, embed config, payments, calling IDs, Interakt, and ads tokens.

**Where to find it:** Footer gear → **Settings** (`/settings/*`).

---

### CRM embed inbox

**What it does:** Embeddable inbox iframe for your external CRM (e.g. americanhairline.com CRM) so agents chat without leaving the CRM.

**Where to find it:** `/embed/inbox` (configured in Settings → Embed).

---

### API access

**What it does:** REST API with bearer tokens for sending messages, looking up contacts, and receiving outbound webhooks for events.

**Where to find it:** Settings → **API** (`/settings/api`).

---

### Data import / export

**What it does:** Import historical WhatsApp chats, export contacts, purge test data, and run fix tools.

**Where to find it:** Settings → **Data** (`/settings/data`). Owner only.

---

### Demo mode

**What it does:** Runs the UI with fake data for training — no real messages sent.

**Where to find it:** Enabled via `NEXT_PUBLIC_DEMO_MODE=true` in environment (not for production).

---

### Planned (routes exist, limited UI)

- **Website widget** (`/widget`) — floating WhatsApp button for your website
- **Commerce** (`/commerce`) — Meta catalog integration

---

## Section 3 — All Integrations Available

### Meta WhatsApp Cloud API (official)

| | |
|---|---|
| **What it does** | Official WhatsApp Business API — send/receive messages, templates, media, read receipts, and WhatsApp Calling. |
| **Credentials needed** | Meta App ID, App Secret, permanent access token, WhatsApp Business Account ID (WABA), Phone Number ID, webhook verify token. Stored as portfolio env vars (`PORTFOLIO_AHL_MAIN_*`). |
| **Where to configure** | Environment file on server; Settings → **Numbers** for Embedded Signup; Meta Developer Console for webhook URL `https://wa.hairscalptradingco.com/api/webhook`. |

---

### WAHA (unofficial WhatsApp gateway)

| | |
|---|---|
| **What it does** | Connects personal/unofficial WhatsApp numbers via a self-hosted WAHA server. Good when Meta official API is not available for a number. |
| **Credentials needed** | `WAHA_SERVER_URL`, `WAHA_API_KEY`. Session name must match the `business_numbers` row. |
| **Where to configure** | Server `.env.local`; webhook via `/api/waha/set-webhook`. Sends route automatically when WAHA env is set. |

---

### Evolution API (unofficial)

| | |
|---|---|
| **What it does** | Alternative unofficial gateway (Baileys-based). QR scan to connect, groups, status posts, history sync. |
| **Credentials needed** | `EVOLUTION_SERVER_URL`, `EVOLUTION_GLOBAL_API_KEY`. |
| **Where to configure** | Settings → **Numbers** → Add Evolution; QR modal connects instance. |

---

### Interakt (BSP)

| | |
|---|---|
| **What it does** | Business Solution Provider — hosted WhatsApp API alternative to direct Meta. |
| **Credentials needed** | Interakt API key per WABA; webhook secret auto-generated. |
| **Where to configure** | Settings → **Interakt**; register webhook URL in Interakt dashboard. |

---

### LeadSquared CRM

| | |
|---|---|
| **What it does** | Lead create/update, activity logging, owner sync, stage webhooks, backfill, drip triggers. Supports two LSQ accounts (`LSQ_*` and `LSQ2_*`). |
| **Credentials needed** | Host URL, Access Key, Secret Key, optional activity event code. |
| **Where to configure** | Server env vars; UI at **LeadSquared** integration page for webhooks and sync tools. |

---

### Razorpay

| | |
|---|---|
| **What it does** | Payment links sent in chat; webhook confirms payment status. |
| **Credentials needed** | Key ID, Key Secret, Webhook Secret. |
| **Where to configure** | Server env + Settings → **Payments** (per clinic: American Hairline / Alchemane). |

---

### PayU

| | |
|---|---|
| **What it does** | UPI QR and invoice payments as an alternative to Razorpay. |
| **Credentials needed** | Merchant Key, Merchant Salt; `PAYU_ENV` = test or live. |
| **Where to configure** | Server env + Settings → **Payments**. |

---

### OpenAI

| | |
|---|---|
| **What it does** | Powers AI auto-reply, RAG embeddings, transcription, spell-correct, campaign magic text, and assistant chat. |
| **Credentials needed** | `OPENAI_API_KEY`. |
| **Where to configure** | Server `.env.local`. |

---

### OpenRouter

| | |
|---|---|
| **What it does** | Drop-in replacement for OpenAI — same API format, access to many models through one key. Used automatically when `OPENROUTER_API_KEY` is set (takes priority over direct OpenAI). |
| **Credentials needed** | `OPENROUTER_API_KEY`. Optional referer/title headers are sent automatically for routing. |
| **Where to configure** | Server `.env.local` — set `OPENROUTER_API_KEY=` and leave or clear `OPENAI_API_KEY` if not using direct OpenAI. |

---

### Ollama (local AI)

| | |
|---|---|
| **What it does** | Run AI models on your own server — no per-token OpenAI bill. Selected per number in Automation as provider `ollama`. |
| **Credentials needed** | `OLLAMA_BASE_URL`, optional `OLLAMA_API_KEY`, `OLLAMA_MODEL`. |
| **Where to configure** | Server env; Settings → **AI** for health check. |

---

### Ozonetel

| | |
|---|---|
| **What it does** | Outbound click-to-call from dashboard; inbound call webhooks. |
| **Credentials needed** | Username, API key, campaign name, base URL; per-agent Ozonetel agent ID on team member profile. |
| **Where to configure** | Server env; Settings → **Calling**; Telephony integration page. |

---

### Tata Tele (Smartflo)

| | |
|---|---|
| **What it does** | Alternative telephony provider for click-to-call. |
| **Credentials needed** | API token, caller ID, base URL; per-agent agent number on team member. |
| **Where to configure** | Server env; Settings → **Calling**. |

---

### Google Calendar (booking)

| | |
|---|---|
| **What it does** | Availability slots and appointment booking via public link. |
| **Credentials needed** | Service account email, private key, calendar ID, optional impersonate user; booking capacity/window env vars. |
| **Where to configure** | Server env; enable **Date Align** capability on the number. |

---

### Google OAuth (login only)

| | |
|---|---|
| **What it does** | “Sign in with Google” on login page — restricted to `@americanhairline.com` and `@alchemane.com` emails. |
| **Credentials needed** | Configured in Supabase Auth dashboard (not in app env). |
| **Where to configure** | Supabase project → Authentication → Providers → Google. |

---

### Meta Ads token

| | |
|---|---|
| **What it does** | Resolves Click-to-WhatsApp ad names for UTM/source tracking on new leads. |
| **Credentials needed** | `META_ADS_TOKEN` with ads_read permission. |
| **Where to configure** | Settings → **Ads / Marketing**. |

---

### ElevenLabs

| | |
|---|---|
| **What it does** | Voice synthesis for home assistant feature (if enabled). |
| **Credentials needed** | API key and voice ID. |
| **Where to configure** | Server env. |

---

### Magic Message image service

| | |
|---|---|
| **What it does** | Separate microservice that renders AI-generated image cards. |
| **Credentials needed** | `MAGIC_MESSAGE_IMAGE_API_URL` pointing to running service (default port 3002). |
| **Where to configure** | Server env; deploy `services/image-generator/` on VPS. |

---

## Section 4 — Database and Data Sources

### Where data lives

All persistent data is in **Supabase (PostgreSQL)**. The web app reads and writes through secure API routes. Media files (images, voice notes) are stored in Supabase Storage or referenced by Meta/Evolution URLs.

### Major tables (what each stores)

| Table | Purpose |
|-------|---------|
| `contacts` | One row per customer per WhatsApp business line — name, phone, assignment, labels, unread count, CRM stage cache, bot state |
| `messages` | Every inbound and outbound message — text, media, status, timestamps |
| `business_numbers` | Registered WhatsApp lines — provider (meta/evolution/interakt), display name, connection state |
| `team_members` | Users, roles, teams, telephony IDs, monitor flag |
| `teams` | Team groupings (e.g. Sales, Service) |
| `role_permissions` / `team_member_permissions` / `team_permissions` | Who can see and do what |
| `member_number_access` | Which numbers each agent can access (full inbox vs assigned-only) |
| `automation_configs` | Per-number AI settings — prompt, model, RAG, delays, LSQ mappings |
| `knowledge_chunks` | FAQ/SOP text blocks with vector embeddings for RAG |
| `automation_logs` | Audit trail of every AI reply |
| `trigger_flows` / `trigger_nodes` / `trigger_edges` | Visual keyword automation flows |
| `campaigns` / `campaign_recipients` | Bulk send jobs and per-contact delivery state |
| `drip_campaigns` / `drip_steps` / `drip_runs` | Multi-step sequences triggered by CRM events |
| `payments` / `payment_accounts` | Payment links and Razorpay/PayU account bindings |
| `refund_requests` | Refund workflow from contact panel |
| `bookings` | Appointment records from Google Calendar flow |
| `whatsapp_calls` | WhatsApp voice call records |
| `tasks` / `task_comments` | Internal task board |
| `quick_replies` | Canned responses per number |
| `contact_notes` | Internal notes on customers |
| `contact_labels` | Workspace label definitions |
| `agent_targets_role` / `agent_targets_member` | Daily KRA targets |
| `user_activity_days` | Daily activity metrics for reports |
| `haridwar_sales_agents` | Lead distribution agent queue (legacy name — maps to sales agents) |
| `lead_distribution_groups` | Stage-to-agent routing rules |
| `lsq_webhook_events` / `lsq_push_failures` | CRM webhook log and retry queue |
| `api_tokens` / `outbound_webhooks` | External API access and event forwarding |
| `chat_import_jobs` | Historical chat import progress |

### How contacts are created

1. **Inbound WhatsApp message** — webhook creates contact + first message automatically.
2. **Outbound first message** — agent starts new chat from Inbox → contact created.
3. **CRM webhook** — LeadSquared sends lead data → contact linked by phone.
4. **Campaign** — recipient row creates or updates contact.
5. **API** — external system creates contact via REST API.
6. **Import** — Settings → Data → chat import from export file.
7. **Nightly sync** — cron links orphan contacts to LSQ leads.

### Key contact fields

- `wa_id` — WhatsApp phone (with country code)
- `business_phone_number_id` — which business line this chat belongs to
- `name`, `nickname` — display names
- `assigned_to` / `assigned_to_email` — which agent owns the chat
- `label_ids`, `tags` — organisation labels
- `unread_count`, `last_inbound_at` — inbox state
- `lsq_stage`, `lsq_lead_number`, `lsq_prospect_id`, `lsq_owner_email` — cached CRM fields
- `status` — open / closed / etc.
- `bot_blocked_at`, `offtopic_strikes` — AI moderation state

### Data import sources

- **WhatsApp chat export** — Settings → Data → Import (creates `chat_import_jobs`)
- **Google Sheets** — not built-in today; possible via API or future integration (see Section 10)
- **LeadSquared backfill** — Integration page → backfill button pulls leads into contacts
- **Evolution history sync** — automatic on connect + nightly cron

---

## Section 5 — How to Set Up the Team

### Step 1: Owner account

The first account with role **Owner** has full access. Sign up at `/signup` with an allowed email domain (`@americanhairline.com` or `@alchemane.com`). If self-signup is pending approval, the owner approves in Settings → Team.

### Step 2: Invite team members

1. Go to **Settings → Team**.
2. Add member email, name, role, and optional team assignment.
3. Member receives login instructions (email/password or Google sign-in).
4. Pending signups appear for owner approval if self-service signup is enabled.

### Step 3: Understand roles

| Role | Typical use |
|------|-------------|
| **Owner** | Business owner — full access including data purge, portfolios, payments |
| **Superadmin** | IT / ops lead — manage permissions, numbers, calling config |
| **Admin** | Team manager — campaigns, automation, reports, most settings |
| **Teammate** | Front-line agent — inbox, assigned contacts, limited settings |

Higher roles can assign contacts to lower roles. Teammates cannot assign to anyone.

### Step 4: Assign WhatsApp numbers to team members

1. **Settings → Permissions** (superadmin) or **Team** member sheet.
2. Under **Number access**, choose per number:
   - **Full** — see all chats on that number
   - **Assigned only** — see only chats assigned to them
3. Save.

### Step 5: Number masking

When **mask phone numbers** is enabled for a role or member, agents see partially hidden phone numbers (e.g. `91******3210`) instead of the full number. Owners typically see full numbers. Configure in Settings → Permissions → capability toggles.

### Step 6: Daily targets (KRA)

1. **Settings → Targets** (owner).
2. Set default daily reply count per **role** (e.g. Teammate = 40 replies/day).
3. Override for specific **members** if needed.
4. Team leads view progress in **Reports** and the Team KRA shortcut.

### Step 7: Team leads and monitors

- **Team lead** (`is_team_lead`) — sees team-scoped reports and KRA for their team.
- **Monitor** (`is_monitor`) — leads owned by monitors are treated as unassigned for distribution purposes.

---

## Section 6 — How to Connect WhatsApp Numbers

### Option A: Meta Cloud API (official — recommended for main brand)

1. Create a Meta app with WhatsApp product in [developers.facebook.com](https://developers.facebook.com).
2. Add env vars on server: `PORTFOLIO_AHL_MAIN_APP_ID`, `APP_SECRET`, `ACCESS_TOKEN`, `BUSINESS_ACCOUNT_ID`, `VERIFY_TOKEN`, `PHONE_IDS`, `EMBEDDED_CONFIG_ID`.
3. In Meta dashboard, set webhook URL: `https://wa.hairscalptradingco.com/api/webhook` with your verify token.
4. In app: **Settings → Numbers → Connect WhatsApp** — use Embedded Signup popup to add the number.
5. Click **Subscribe webhook** on the number row.
6. Assign number to portfolio **American Hairline Main**.
7. **Settings → Capabilities** — enable AI, LSQ, calls as needed.
8. **Automation** — configure AI prompt and test with whitelist.
9. Send a test message to the number and confirm it appears in Inbox.

### Option B: WAHA (unofficial)

1. Deploy WAHA on `waha.hairscalptradingco.com` (already in env template).
2. Set `WAHA_SERVER_URL` and `WAHA_API_KEY` on messaging server.
3. Create a `business_numbers` row with session name matching WAHA session.
4. Call `/api/waha/set-webhook` or configure webhook in WAHA admin → `/api/waha/webhook/[session]`.
5. Test send — `send-message` auto-routes to WAHA when env is set.
6. Set up automation and capabilities same as Meta.

### Option C: Evolution API (unofficial)

1. Deploy Evolution on your VPS; set `EVOLUTION_SERVER_URL` and `EVOLUTION_GLOBAL_API_KEY`.
2. **Settings → Numbers → Add Evolution** — enter instance name.
3. Scan QR code with the phone’s WhatsApp.
4. Wait for connection state **open** — webhook is set automatically.
5. Optional: **Sync history** to backfill old messages.
6. Group numbers into clusters via Numbers UI if you have multiple Evolution lines.
7. Configure automation and test.

### Option D: Interakt BSP

1. Get Interakt API key from Interakt dashboard.
2. **Settings → Interakt** → add WABA number.
3. Copy webhook URL shown → paste in Interakt dashboard.
4. Number appears in Inbox with provider `interakt`.
5. Configure automation — sends route through Interakt API.

### After connecting any number

1. **Assign to portfolio** — for Meta numbers, ties credentials together.
2. **Set capabilities** — turn AI, LSQ create, photo stage, call record on/off per number.
3. **Automation tab** — write persona, upload knowledge chunks, set human takeover minutes.
4. **Lead defaults** — set Source = Alchemane / American Hairline for CRM tracking.
5. **Test** — send inbound message, confirm AI reply (if enabled) and CRM sync.

---

## Section 7 — How the AI Works

### Turning on AI auto-reply per number

1. Go to **Automation** → select the WhatsApp number.
2. Toggle **Enabled**.
3. Write the **system prompt** (persona, tone, rules — use ✨ Generate for help).
4. Choose **model** (e.g. `gpt-4o-mini` via OpenRouter or OpenAI).
5. Choose **provider**: OpenAI/OpenRouter (default) or Ollama (self-hosted).
6. Set **human takeover minutes** — if an agent replies manually within this window, AI stays silent.
7. Set **reply delay seconds** — optional pause so replies feel human.
8. Save and test with **Test** button or whitelist numbers.

### Uploading SOPs as knowledge base

1. In **Automation** → **Knowledge base** section for the number.
2. Add **chunks** — each chunk is 200–500 characters answering one topic (pricing, hours, refund policy, etc.).
3. Use ✨ **Generate knowledge chunk** for AI-assisted drafting.
4. Chunks are embedded and stored in `knowledge_chunks` table.

### How RAG works

When a customer messages:

1. System embeds the customer’s latest message.
2. Searches knowledge chunks for the most similar content (vector similarity).
3. Injects top matching chunks into the prompt as **RELEVANT KNOWLEDGE**.
4. AI replies using only those facts + system prompt rules.
5. Reply is logged in `automation_logs` with which chunks were used.

This prevents the AI from inventing prices or policies not in your documents.

### Training with FAQs

- Add one chunk per FAQ question/answer pair.
- Keep chunks short and factual.
- Update chunks when policies change — no retraining needed, changes apply immediately.
- Use **RAG core prompt** to instruct the model to cite only knowledge chunks.

### Human takeover rules

- **human_takeover_minutes** — agent activity pauses AI.
- **bot_blocked_at** — manual block on a contact stops all AI.
- **Off-topic strikes** — repeated off-topic messages can auto-block bot.
- **Trigger flows** can assign to human or send template before AI runs.

### Monitoring AI quality

1. **Automation logs** tab — read every AI reply with prompt token counts and RAG chunks used.
2. **Automation test** — send test messages without affecting real customers.
3. **Reports** — track response times and volumes.
4. Review **offtopic_strikes** contacts in Inbox.
5. Tune prompt and knowledge chunks based on bad replies.

### Visual trigger flows (non-AI automation)

Separate from AI: keyword matches → chain of actions (send message, assign agent, add tag, wait for reply, call webhook). Built in React Flow UI under Automation → Trigger Flows tab.

---

## Section 8 — What We Still Need to Connect for American Hairline

Based on current environment templates (`.env.local` / `env.production.txt`), here is what is **missing or placeholder**, in **priority order**:

### Priority 1 — Must have for go-live

| Item | Status | Action |
|------|--------|--------|
| Meta WhatsApp portfolio | `YOUR_*` placeholders | Complete Embedded Signup; fill App ID, token, WABA ID, phone ID |
| OpenAI or OpenRouter | `sk-YOUR_OPENAI_KEY` / empty OpenRouter | Add real `OPENROUTER_API_KEY` or `OPENAI_API_KEY` for AI features |
| Razorpay | `YOUR_RAZORPAY_*` | Add live keys + webhook URL in Razorpay dashboard |
| Supabase | Set in env | Confirm production project URLs and keys are correct |

### Priority 2 — Core operations

| Item | Status | Action |
|------|--------|--------|
| WAHA | URL set, key set | Confirm session connected; add `business_numbers` rows per session |
| Evolution | `YOUR_VPS_IP` placeholder | Deploy Evolution or rely on WAHA only |
| LeadSquared | All blank | Add host + keys OR plan custom CRM replacement; funnel strip needs `lsq_stage` on contacts |
| Magic Message image service | `localhost:3002` | Deploy image generator on VPS; set production URL |

### Priority 3 — Revenue and booking

| Item | Status | Action |
|------|--------|--------|
| PayU | Blank | Add merchant key/salt if using PayU alongside Razorpay |
| Google Calendar | All blank | Service account + calendar ID for Date Align / booking links |
| Payment accounts in UI | — | Settings → Payments → bind Razorpay/PayU per clinic brand |

### Priority 4 — Sales team tooling

| Item | Status | Action |
|------|--------|--------|
| Lead distribution agents | DB table exists | Add agents in Lead Distribution UI; rename `haridwar_sales_agents` when ready |
| Ozonetel / Tata Tele | All blank | Add credentials + per-agent IDs in Settings → Calling |
| Meta Ads token | Blank | For CTWA ad attribution on new leads |
| CRM embed | `crm.hairscalptradingco.com` | Confirm iframe origin matches live CRM URL |

### Priority 5 — Nice to have

| Item | Status | Action |
|------|--------|--------|
| Ollama local AI | Blank | Optional cost saving for high-volume numbers |
| ElevenLabs | Blank | Voice assistant only |
| Google Maps static key | Blank | Location maps in messages if used |
| Interakt | Not configured | Only if using Interakt BSP instead of direct Meta |

### Rebrand remnants still in codebase (not env)

- Funnel stage strip still shows legacy hair-transplant stages until `lib/lead-stages.ts` is updated
- `haridwar_sales_agents` table name is legacy
- Some AI placeholder copy still references medical terms in components not yet rebranded

---

## Section 9 — Daily Operations Guide

### Morning routine (team lead)

1. Open **Home** — check unread counts and expiring 24h windows.
2. Open **Reports** — yesterday’s agent productivity vs targets.
3. Check **Lead Distribution** queue for stuck unassigned leads.
4. Review **LSQ push failures** if CRM integration is active.

### Agent workflow (each conversation)

1. **Login** → land on Inbox (or Home first).
2. Pick next chat from **Open** or **Unread** filter.
3. Read customer message; check **right panel** for CRM stage, history, notes.
4. Option A: Type reply manually. Option B: Click **Suggested reply** in AHL AI panel. Option C: Let AI auto-reply if enabled.
5. Use **Quick replies** for common answers.
6. Use **Templates** if outside 24-hour window.
7. Send **payment link** (₹ button) when customer is ready to pay.
8. Add **internal note** for context other agents need.
9. **Assign** chat to specialist if needed.
10. Update **label** (e.g. Hot lead, Follow-up Friday).
11. Mark done or leave open based on your process.

### Using AI safely

- If AI is wrong, reply manually — takeover pauses bot for configured minutes.
- Use **block bot** on contact if customer should never get AI again.
- Escalate complex cases via **Tasks** assigned to senior agent.

### Logging CRM notes

- Activities log automatically when LSQ is connected.
- Manual notes: contact panel → Notes section.
- LSQ stage changes: from CRM or funnel strip filter (when stages are configured).

### Running a campaign

1. **Campaigns** → New campaign.
2. Choose template or Magic Message.
3. Select audience (labels, stages, tags).
4. Schedule send time.
5. Monitor delivery stats on campaign detail page.
6. Handle replies in Inbox — they appear as normal chats.

### End of day (team lead)

1. **Reports** — confirm all agents hit KRA.
2. Reassign open chats still unowned.
3. Check **Tasks** board for overdue items.

---

## Section 10 — What Can Be Integrated in Future

The platform is built as a hub with webhooks, API tokens, and provider adapters. These integrations are **not built yet** but fit the architecture:

### Salon / clinic software

- **Zenoti** — appointment sync, client profile lookup, service history pushed into contact panel via API webhook.
- **Custom AHL CRM** — replace LeadSquared using same webhook patterns as `lib/lsq-webhook.ts`; embed inbox already supports iframe.

### Call intelligence

- **Runo** — ingest call recordings and scores into `calls` table and contact timeline.
- **Call Audit** — post-call quality scores displayed in Reports per agent.

### Data sync

- **Google Sheets** — scheduled export/import of contacts or campaign lists via Apps Script → `/api/contacts` endpoints.
- **Zapier / Make** — outbound webhooks already fire on message events; extend with more event types.

### Social channels

- **Instagram DMs** — Meta same app family; would need new webhook handler and `contacts` channel field.
- **Facebook Messenger** — similar Meta Graph pattern.

### Commerce

- **Meta Catalog / WhatsApp Commerce** — route `/commerce` is placeholder; would connect product catalogue to template messages.

### Payments

- **Stripe** — alternative payment provider alongside Razorpay/PayU.
- **BNPL providers** — payment link abstraction in `lib/payment-providers.ts`.

### AI enhancements

- **Fine-tuned models** — OpenRouter supports custom models; swap model ID in automation config.
- **Voice AI** — ElevenLabs + Whisper already partially wired for assistant; extend to auto voice replies.

### Infrastructure

- **Multi-region WAHA** — multiple WAHA servers with per-number env routing.
- **Read replicas** — Supabase read replica for heavy Reports queries at scale.

---

## Quick Reference — URLs and Paths

| Item | Path |
|------|------|
| Production app | https://wa.hairscalptradingco.com |
| Login | `/login` |
| Inbox | `/dashboard` |
| Settings | `/settings/team` (and sub-tabs) |
| Meta webhook | `/api/webhook` |
| WAHA webhook | `/api/waha/webhook/[session]` |
| Evolution webhook | `/api/evolution/webhook/[name]` |
| Public booking | `/book/[token]` |
| CRM embed | `/embed/inbox` |
| Deploy guide | `DEPLOY.md` in repo root |

---

## Support and technical ownership

- **Codebase:** https://github.com/ahl-official/ahl-messaging
- **Deploy:** PM2 on VPS, port 3001, Nginx reverse proxy — see `DEPLOY.md`
- **Database migrations:** `supabase/migrations/` — run in order on Supabase project
- **Environment:** copy `env.production.txt` → `.env.local` on server; never commit secrets to git

---

*End of AHL System Guide*
