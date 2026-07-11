# AHL Messaging — Complete System Guide

**American Hairline / Alchemane**  
**Product:** AHL Messaging  
**Last updated:** July 2026  

This guide is written for business owners and team leads. It lists every page URL in the product, explains what each screen does, then walks through every Settings tab and what you must configure for each feature to work.

---

## Part 1 — Every page URL in the app

Below is a complete inventory of user-facing routes under the `app/` folder (pages you can open in a browser). API routes under `/api/...` are listed later in a short appendix because agents do not open those as screens.

### Auth and public pages

| URL | File | Who uses it |
|-----|------|-------------|
| `/` | `app/page.tsx` | Redirects to `/dashboard` (middleware may send guests to `/login`) |
| `/login` | `app/(auth)/login/page.tsx` | Staff sign-in |
| `/signup` | `app/(auth)/signup/page.tsx` | New staff account request |
| `/forgot-password` | `app/(auth)/forgot-password/page.tsx` | Password reset request |
| `/reset-password` | `app/(auth)/reset-password/page.tsx` | Set a new password from email link |
| `/book/[token]` | `app/book/[token]/page.tsx` | Public booking page for a client (no staff login) |
| `/embed/inbox` | `app/(embed)/embed/inbox/page.tsx` | Inbox inside a CRM iframe |

### Left navigation (main product)

| URL | Nav label | File |
|-----|-----------|------|
| `/home` | Home | `app/(dashboard)/home/page.tsx` |
| `/dashboard` | Inbox | `app/(dashboard)/dashboard/page.tsx` |
| `/bird-eye` | Bird's Eye | `app/(dashboard)/bird-eye/page.tsx` |
| `/contacts` | Contacts | `app/(dashboard)/contacts/page.tsx` |
| `/calls` | Call history | `app/(dashboard)/calls/page.tsx` |
| `/templates` | Templates | `app/(dashboard)/templates/page.tsx` |
| `/templates/new` | (from Templates) | `app/(dashboard)/templates/new/page.tsx` |
| `/templates/[id]/edit` | (from Templates) | `app/(dashboard)/templates/[id]/edit/page.tsx` |
| `/quick-replies` | Quick Replies | `app/(dashboard)/quick-replies/page.tsx` |
| `/campaigns` | Campaigns | `app/(dashboard)/campaigns/page.tsx` |
| `/automation` | Automation | `app/(dashboard)/automation/page.tsx` |
| `/lead-distribution` | Lead Distribution | `app/(dashboard)/lead-distribution/page.tsx` |
| `/integrations/lsq` | CRM | `app/(dashboard)/integrations/lsq/page.tsx` |
| `/integrations/telephony` | Telephony | `app/(dashboard)/integrations/telephony/page.tsx` |
| `/tasks` | Tasks | `app/(dashboard)/tasks/page.tsx` |
| `/reports` | Reports | `app/(dashboard)/reports/page.tsx` |
| `/settings/targets` | Team KRA (team leads) | `app/(dashboard)/settings/targets/page.tsx` |
| `/settings` | Settings (footer) | Redirects to first allowed settings tab |

### Settings tabs

| URL | Tab label | File |
|-----|-----------|------|
| `/settings/team` | Team | `app/(dashboard)/settings/team/page.tsx` |
| `/settings/teams` | (legacy → groups) | `app/(dashboard)/settings/teams/page.tsx` |
| `/settings/labels` | Labels | `app/(dashboard)/settings/labels/page.tsx` |
| `/settings/permissions` | Permissions | `app/(dashboard)/settings/permissions/page.tsx` |
| `/settings/numbers` | Numbers | `app/(dashboard)/settings/numbers/page.tsx` |
| `/settings/capabilities` | Capabilities | `app/(dashboard)/settings/capabilities/page.tsx` |
| `/settings/targets` | Targets | `app/(dashboard)/settings/targets/page.tsx` |
| `/settings/notice` | Notice | `app/(dashboard)/settings/notice/page.tsx` |
| `/settings/portfolios` | Portfolios | `app/(dashboard)/settings/portfolios/page.tsx` |
| `/settings/api` | API | `app/(dashboard)/settings/api/page.tsx` |
| `/settings/data` | Data | `app/(dashboard)/settings/data/page.tsx` |
| `/settings/ai` | AI | `app/(dashboard)/settings/ai/page.tsx` |
| `/settings/embed` | Embed | `app/(dashboard)/settings/embed/page.tsx` |
| `/settings/payments` | Payments | `app/(dashboard)/settings/payments/page.tsx` |
| `/settings/calling` | Calling | `app/(dashboard)/settings/calling/page.tsx` |
| `/settings/interakt` | Interakt | `app/(dashboard)/settings/interakt/page.tsx` |
| `/settings/ads` | Ads / Marketing | `app/(dashboard)/settings/ads/page.tsx` |

### Other dashboard pages (not always in the left nav)

| URL | Purpose | File |
|-----|---------|------|
| `/profile` | Your profile and sessions | `app/(dashboard)/profile/page.tsx` |
| `/widget` | Website WhatsApp widget (coming soon) | `app/(dashboard)/widget/page.tsx` |
| `/commerce` | Meta catalog commerce (coming soon) | `app/(dashboard)/commerce/page.tsx` |
| `/integrations` | Generic integrations hub (coming soon) | `app/(dashboard)/integrations/page.tsx` |

---

## Part 2 — What each page does (plain English)

### Root and auth

**`/`**  
This is not a real home screen. Opening the site root immediately sends you to the Inbox (`/dashboard`) if you are logged in, or the login flow if you are not. You do not configure anything here.

**`/login`**  
Staff sign in with Google (primary) or email/password depending on how Supabase Auth is set up. Sign-in is restricted to allowed work domains via `NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN` (default includes `americanhairline.com` and `alchemane.com`). If a new Google user is waiting for owner approval, they see a pending banner instead of the inbox.

**`/signup`**  
Lets a new teammate create an account. New accounts often sit in **pending approval** until an owner approves them under Settings → Team. Configure Google OAuth in Supabase and keep the email domain allowlist correct.

**`/forgot-password` and `/reset-password`**  
Standard password recovery. The forgot page emails a link; the reset page accepts the new password. Requires Supabase Auth email templates and `NEXT_PUBLIC_APP_URL` so links point at the right host.

**`/book/[token]`**  
A public page the client opens from a “Date Align” booking link. They pick a date; the booking is stored and optionally written to Google Calendar. Needs booking created from Inbox (`can_align_dates` permission) and optional Google Calendar env vars (`GOOGLE_SERVICE_ACCOUNT_EMAIL`, private key, `GOOGLE_CALENDAR_ID`).

**`/embed/inbox`**  
A slim WhatsApp inbox meant to sit inside your CRM in an iframe. Query params such as `?wa=` and `?c=` can deep-link a number or contact. Configure allowed parent origins under Settings → Embed and set `CRM_EMBED_ORIGIN` / cookie domain if CRM and messaging live on different subdomains.

---

### Left nav — Home through Reports

**`/home` — Home**  
Morning snapshot for the logged-in agent: open conversations, unread counts by WhatsApp number, recent activity, and chats that may be near Meta’s 24-hour reply window. Open it from the left sidebar icon labelled **Home**. It needs at least one connected WhatsApp number and normal Supabase credentials; no extra third-party setup beyond the inbox itself.

**`/dashboard` — Inbox**  
This is the main workspace: conversation list on the left, chat in the centre, Contact Details on the right. Agents search, filter All / Active / Closed / Groups, reply with text or media, send templates, use quick replies, assign chats, update CRM stage, and open AI or payment tools. Find it under **Inbox** in the left nav. It needs a connected number under Settings → Numbers, panel permission `inbox`, and `NEXT_PUBLIC_APP_URL` so webhooks deliver messages.

**`/bird-eye` — Bird's Eye**  
Supervisor-style view of many live chats at once so leads can monitor without taking over every conversation. Open **Bird's Eye** in the left nav (same `inbox` panel permission as Inbox). It needs the same WhatsApp connections as Inbox and is most useful once several agents are active.

**`/contacts` — Contacts**  
A searchable hub of all customers across numbers, separate from the live chat list. Managers use it to audit the database, find a lead by name or phone, and open detail. Open **Contacts** in the left nav (`contacts` panel). Data is created automatically when messages arrive; no separate CRM is required for the list itself to fill.

**`/calls` — Call history**  
History of WhatsApp Calling sessions and PSTN click-to-call attempts, with recordings or transcripts when those capabilities are on. Open **Call history** in the left nav. For WhatsApp call features, enable call recording / transcribe under Settings → Capabilities. For phone dialling, configure Settings → Calling (Ozonetel / Tata Tele) and map each agent’s dialler ID.

**`/templates` — Templates**  
Library of Meta-approved WhatsApp message templates used when the 24-hour free-form window is closed and for bulk campaigns. Open **Templates**; create at `/templates/new` and edit at `/templates/[id]/edit`. Needs official Meta Cloud API / WABA credentials (`PORTFOLIO_*` or `WHATSAPP_*` env vars) and permission `can_manage_templates` for editors.

**`/quick-replies` — Quick Replies**  
Saved canned responses agents insert into the composer in one click (greetings, address, common FAQs). Open **Quick Replies** in the left nav, or the Quick Replies button inside a chat. Needs only the `quick_replies` panel and a team that writes the reply library—no external API.

**`/campaigns` — Campaigns**  
Bulk outreach: pick an audience, choose a template or Magic Message content, schedule or send, and watch delivery progress. Open **Campaigns** (admin role or higher). Needs connected numbers, approved templates for Meta sends, and `WEBHOOK_INTERNAL_TOKEN` on the server so the 30-second campaign worker (`/api/campaigns/tick`) actually runs.

**`/automation` — Automation**  
Three related tools in one area: AI auto-reply settings per WhatsApp number, Knowledge Base / SOP chunks for RAG, and Trigger Flows (keyword → assign / tag / send / wait / webhook). Open **Automation** in the left nav. Needs AI keys (`OPENROUTER_API_KEY` preferred, or `OPENAI_API_KEY`), knowledge content uploaded, per-number automation enabled, and `WEBHOOK_INTERNAL_TOKEN` for the automation sweep.

**`/lead-distribution` — Lead Distribution**  
Rules and agent roster for automatically assigning new leads (round-robin / stage / brand), plus an off-hours queue. Open **Lead Distribution**. Needs agents configured in this UI, a public webhook URL (`/api/lead-distribution/webhook/[secret]`), optional `LEAD_DIST_WEBHOOK_BASE`, and the internal tick token so `/api/lead-distribution/tick` drains the queue.

**`/integrations/lsq` — CRM**  
LeadSquared (and related CRM tooling) control centre: connection status, webhook generator, event log, backfill tools, push-failure retries, nightly Evolution→LSQ sync, and Evolution lead-create toggles. Open **CRM** in the left nav. Needs `LSQ_HOST`, `LSQ_ACCESS_KEY`, `LSQ_SECRET_KEY` (optional `LSQ2_*` for a second read-only account). AHL Firebase lead create uses `AHL_CRM_LEADS_URL` and `AHL_CRM_API_KEY` and is wired on **WAHA, Meta, and Evolution** inbound via `ahlEnsureLeadForContact` (no-ops until both env vars are set).

**`/integrations/telephony` — Telephony**  
Click-to-call configuration for a universal HTTP connector (merge fields like agent phone and lead phone) and links into Ozonetel / Tata Tele behaviour. Open **Telephony**. Needs `TELEPHONY_AUTH_TOKEN` for outbound auth, optional `TELEPHONY_CONNECTOR_KEY` shown in the UI, and provider credentials under Settings → Calling.

**`/tasks` — Tasks**  
Personal and team follow-up tasks (description, priority, assignee, due date) with open-count badges on the nav. Open **Tasks**. Needs the `tasks` panel only; tasks can also be created from a contact in the Inbox.

**`/reports` — Reports**  
Agent and team performance: volume, speed, open work, and progress against KRAs. Open **Reports**. Team leads always get this shortcut even if some panels are restricted. Pair with Settings → Targets so “hit rate” means something concrete.

**`/settings/targets` — Team KRA (lead shortcut)**  
Same Targets page as in Settings, exposed in the left nav only for users marked as team leads. Use it to set or review daily goals without hunting through Settings. Needs `is_team_lead` on the member and owner-level target definitions (or lead access granted by layout).

**`/settings` — Settings entry**  
Not a content page. It redirects to the first Settings tab the current admin is allowed to see (Team, Labels, Numbers, etc.). Admins and above open it from the gear icon at the bottom of the left nav.

---

### Other dashboard pages

**`/profile`**  
Opened from the user menu (avatar), not the left nav. Edit your display profile and review or revoke login sessions on other devices. Needs a logged-in Supabase session.

**`/widget`**  
Placeholder “coming soon” for a floating WhatsApp button you could put on a marketing site. Not production-ready; no configuration will turn it on yet.

**`/commerce`**  
Placeholder for Meta product catalogue / commerce features. Coming soon; ignore for day-to-day AHL operations.

**`/integrations`**  
Generic integrations landing that is also marked coming soon. Real integrations live at `/integrations/lsq` and `/integrations/telephony`.

---

## Part 3 — Left nav features (what / where / configure)

This section restates each nav item in the exact “2–3 sentences” format: what it does, where it is, what must be configured.

1. **Home** — Shows today’s workload snapshot so agents know where to start. Find it as the first icon in the left sidebar (`/home`). Configure by connecting WhatsApp numbers and ensuring agents have the `home` panel.

2. **Inbox** — Read and reply to all allowed WhatsApp chats in one place with CRM stage, notes, and tools beside the thread. Find it as **Inbox** (`/dashboard`). Configure Numbers, webhooks via `NEXT_PUBLIC_APP_URL`, and the `inbox` panel / number access mode.

3. **Bird's Eye** — Lets supervisors watch many conversations side by side. Find it as **Bird's Eye** (`/bird-eye`). Configure the same as Inbox; grant inbox access to leads who should monitor.

4. **Contacts** — Browse and search the full customer database outside the live chat list. Find it as **Contacts** (`/contacts`). Configure the `contacts` panel; contacts appear automatically from inbound/outbound WhatsApp traffic.

5. **Call history** — Review WhatsApp and phone calls, including recordings when enabled. Find it as **Call history** (`/calls`). Configure Capabilities for recording/transcribe and Settings → Calling for Ozonetel/Tata agent IDs.

6. **Templates** — Manage Meta message templates for outreach outside the 24-hour window. Find it as **Templates** (`/templates`). Configure Meta portfolio / WABA tokens and template-management permission.

7. **Quick Replies** — Store and reuse short standard answers. Find it as **Quick Replies** (`/quick-replies`) or the composer button. Configure by writing replies in that page; enable the `quick_replies` panel.

8. **Campaigns** — Send bulk WhatsApp messages with scheduling and progress. Find it as **Campaigns** (`/campaigns`, admin+). Configure templates or Magic Message, numbers, and `WEBHOOK_INTERNAL_TOKEN` for the background sender.

9. **Automation** — AI auto-replies, SOP knowledge base, and keyword trigger flows. Find it as **Automation** (`/automation`). Configure OpenRouter/OpenAI (and optional Ollama), upload knowledge, enable per-number AI, and set the internal tick token.

10. **Lead Distribution** — Automatically assign new leads to the right sales agents. Find it as **Lead Distribution** (`/lead-distribution`). Configure the agent roster, webhook secret/URL, and tick token.

11. **CRM** — Connect LeadSquared tools (and related sync/backfill) to WhatsApp contacts. Find it as **CRM** (`/integrations/lsq`). Configure `LSQ_*` keys; optionally `AHL_CRM_*` for Firebase lead create on WAHA/Meta/Evolution inbound.

12. **Telephony** — Place click-to-call dials from the messaging product. Find it as **Telephony** (`/integrations/telephony`). Configure `TELEPHONY_AUTH_TOKEN` and provider accounts under Settings → Calling.

13. **Tasks** — Track follow-ups with due dates and assignees. Find it as **Tasks** (`/tasks`). Configure the `tasks` panel; no external API required.

14. **Reports** — Measure agent speed, volume, and KRA progress. Find it as **Reports** (`/reports`). Configure Targets and ensure agents actually work in the Inbox so data exists.

15. **Team KRA** — Quick path for team leads into daily targets. Find it as **Team KRA** (leads only) → `/settings/targets`. Configure `is_team_lead` and enter target numbers on the Targets page.

16. **Settings** — Admin control centre for people, numbers, money, AI, and integrations. Find it as the gear at the bottom of the left nav (`/settings`). Configure by granting admin+ role and the relevant settings tabs in Permissions.

---

## Part 4 — Every Settings tab explained

Open Settings from the gear icon. The dark blue header shows tab pills. Who sees which tab depends on role (`owner` / `superadmin` / `admin`) and `allowed_settings_tabs` in Permissions.

### Team — `/settings/team`

**What it does**  
Invite members, approve pending Google signups, change roles (owner, superadmin, admin, teammate), deactivate people, open per-member Access sheets, manage team groups, and review login activity / sessions. Sub-tabs include **Members**, **Groups**, and **Login activity**. Legacy URL `/settings/teams` deep-links into the groups view.

**Where**  
Settings → **Team**.

**Configure**  
Supabase Google Auth; `NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN`; owners must approve pending users before they can use the inbox.

---

### Labels — `/settings/labels`

**What it does**  
Create the coloured label catalogue used on contacts (for example appointment type, language, VIP). Agents apply these labels in the Contact Details panel and filter the inbox by them.

**Where**  
Settings → **Labels** (admin+).

**Configure**  
Admin access only; invent AHL’s label set. Permission `can_delete_labels` controls who may remove labels.

---

### Permissions — `/settings/permissions`

**What it does**  
Defines what each role can see and do: sidebar panels, settings tabs, messaging capabilities (send, Magic Message, calls, Date Align), CRM sync rights, export rights, and privacy masking (phone, email, source/sub-source). Team and member overrides can tighten or expand defaults. Number access can be **full** or **assigned_only**.

**Where**  
Settings → **Permissions** (superadmin+).

**Configure**  
Decide AHL’s org chart first (who is owner vs teammate), then set role defaults and any team overrides. Owner permissions cannot be locked out.

---

### Numbers — `/settings/numbers`

**What it does**  
Connect and manage WhatsApp business numbers: Meta Embedded Signup, Evolution QR instances, WAHA sessions, Interakt numbers, webhook health, profile pictures, status posting (Evolution), and sync tools. This is the most important setup page after Team.

**Where**  
Settings → **Numbers**.

**Configure**  
For Meta: `PORTFOLIO_*` (or legacy `WHATSAPP_*`) and Embedded Signup app config. For Evolution: `EVOLUTION_SERVER_URL`, `EVOLUTION_GLOBAL_API_KEY`, and `NEXT_PUBLIC_APP_URL` for `/api/evolution/webhook/[name]`. For WAHA: `WAHA_SERVER_URL`, `WAHA_API_KEY`, webhook `/api/waha/webhook/[session]`. Editing some fields is limited to owner/superadmin.

---

### Capabilities — `/settings/capabilities`

**What it does**  
Per-number feature switches: AI on/off, LSQ lead create / extract / activity / photo-stage, call recording, call transcription, and related toggles. Lets you turn expensive or sensitive features on only for the numbers that need them.

**Where**  
Settings → **Capabilities** (admin+).

**Configure**  
Numbers must exist first. Transcription needs OpenAI credentials. LSQ toggles need LSQ env keys.

---

### Targets — `/settings/targets`

**What it does**  
Daily KRA targets by role, with optional per-member overrides. Reports and the Team KRA nav item use these numbers so “100%” means something real.

**Where**  
Settings → **Targets** (owner; team leads can reach this page via layout rules).

**Configure**  
Enter AHL daily goals (for example replies or contacts handled). Tables behind the UI: `agent_targets_role`, `agent_targets_member`.

---

### Notice — `/settings/notice`

**What it does**  
Edit the global notice banner that appears across the dashboard (outages, festival hours, policy reminders). Every logged-in agent sees it.

**Where**  
Settings → **Notice**.

**Configure**  
Write the message in the editor and save; no external API.

---

### Portfolios — `/settings/portfolios`

**What it does**  
Shows Meta Business “portfolio” blocks used when one install manages multiple brands or WABAs. Each portfolio has its own token, app id, verify token, and phone ids.

**Where**  
Settings → **Portfolios** (owner).

**Configure**  
Env: `PORTFOLIO_KEYS` plus `PORTFOLIO_<KEY>_NAME`, `_ACCESS_TOKEN`, `_APP_ID`, `_APP_SECRET`, `_EMBEDDED_CONFIG_ID`, `_BUSINESS_ACCOUNT_ID`, `_VERIFY_TOKEN`, `_PHONE_IDS`, `_DISPLAY_NAME`, `_ACTIVE`, `_PROVIDER`. Rebuild after changing `NEXT_PUBLIC_*` related values.

---

### API — `/settings/api`

**What it does**  
Create API bearer tokens for n8n or custom scripts, register outbound webhooks so AHL can push events to your systems, and read plain-English API documentation for Meta WhatsApp endpoints used by the product.

**Where**  
Settings → **API** (admin+).

**Configure**  
Create tokens in the UI (`api_tokens` table). Point outbound webhooks at HTTPS endpoints you control. Documented public-style APIs live under `/api/v1/...` for token auth.

---

### Data — `/settings/data`

**What it does**  
Owner tools to export chats, import historical chats, fix mismatched numbers, and carefully purge data. Used during migrations and compliance requests.

**Where**  
Settings → **Data** (owner).

**Configure**  
Owner role and `can_export_data` where applicable. Import panels may ask for source DB URL or cookies when migrating from an older system—use carefully on production.

---

### AI — `/settings/ai`

**What it does**  
Global prompt tuning for chat summary, suggested reply, package-shared extraction, output language (English / Hindi / Hinglish), and related assistant behaviour. Also surfaces Ollama health when local models are used.

**Where**  
Settings → **AI** (owner).

**Configure**  
`OPENROUTER_API_KEY` or `OPENAI_API_KEY`; optional `OLLAMA_BASE_URL` / `OLLAMA_MODEL`. Per-number AI still must be enabled under Automation / Capabilities.

---

### Embed — `/settings/embed`

**What it does**  
Controls which CRM website origins may iframe `/embed/inbox` (CSP allowlist) without redeploying code for every CRM domain change.

**Where**  
Settings → **Embed** (owner).

**Configure**  
Add your live CRM origin(s). Env fallback `CRM_EMBED_ORIGIN` (default historically `https://crm.americanhairline.com`). Set `COOKIE_DOMAIN` / `NEXT_PUBLIC_COOKIE_DOMAIN` if auth must span subdomains.

---

### Payments — `/settings/payments`

**What it does**  
Configure Razorpay and PayU merchant accounts per clinic (American Hairline / Alchemane), activate one account per provider, set auto-receipt behaviour, and see webhook base URLs derived from `NEXT_PUBLIC_APP_URL`.

**Where**  
Settings → **Payments** (owner / superadmin).

**Configure**  
Env fallbacks: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PAYU_MERCHANT_KEY`, `PAYU_MERCHANT_SALT`, `PAYU_ENV`. Register webhooks to `/api/payments/webhook/razorpay` and `/api/payments/webhook/payu`. PayU UPI QR may need Playwright on the VPS for deeplink scrape.

---

### Calling — `/settings/calling`

**What it does**  
Stores Ozonetel CloudAgent and Tata Tele Smartflo credentials and maps each team member to their dialler agent id / phone so click-to-call works from a contact.

**Where**  
Settings → **Calling** (superadmin).

**Configure**  
`OZONETEL_USER_NAME`, `OZONETEL_API_KEY`, `OZONETEL_CAMPAIGN`, optional `OZONETEL_BASE_URL`; `TATATELE_API_TOKEN`, `TATATELE_CALLER_ID`, optional `TATATELE_BASE_URL`. Fill per-agent fields on team members.

---

### Interakt — `/settings/interakt`

**What it does**  
Add WhatsApp numbers via the Interakt BSP, generate webhook secrets, and show the webhook URL pattern `/api/interakt/webhook/[secret]`.

**Where**  
Settings → **Interakt** (owner).

**Configure**  
Interakt API keys per number in the UI/DB. Note: LSQ ensure-lead is skipped for Interakt numbers unless that number’s automation is enabled.

---

### Ads / Marketing — `/settings/ads`

**What it does**  
Stores the Meta Ads token used to resolve Click-to-WhatsApp ad names for attribution on inbound chats.

**Where**  
Settings → **Ads / Marketing** (owner).

**Configure**  
`META_ADS_TOKEN` (or the ads token fields managed on this page). Useful when leads arrive from Facebook/Instagram ads into WhatsApp.

---

## Part 5 — How the pieces fit together (day-to-day)

A typical CRM agent’s day uses several of the pages above in sequence.

They sign in at `/login`, check `/home`, then work `/dashboard`. New WhatsApp messages arrive through Meta (`/api/webhook`), Evolution (`/api/evolution/webhook/[name]`), WAHA (`/api/waha/webhook/[session]`), or Interakt (`/api/interakt/webhook/[secret]`). If CRM is configured, a lead may be created or refreshed automatically. The agent updates stage on the contact panel (AHL stages: New Lead, Contacted, Follow Up, NBD Booked, NBD Not Visited, NBD Done, Not Booked, Order Booked, Lost Lead), adds notes and labels, and may assign the chat.

When the Meta 24-hour window is closed, they send a template from `/templates` or the template picker. For bulk work, an admin uses `/campaigns`. For repeated FAQs, `/quick-replies` and Automation knowledge keep answers consistent. Money is collected via the composer Payment button once Settings → Payments is live. Visits are booked via Date Align → `/book/[token]`. Calls go through WhatsApp Calling or Telephony. Follow-ups live in `/tasks`. Managers watch `/bird-eye` and `/reports`, and adjust people under `/settings/team`.

Background workers (campaigns, drips, AI sweep, triggers, lead distribution) only run when `WEBHOOK_INTERNAL_TOKEN` is set and PM2 runs a single Node worker (or worker `0` in cluster). Without that token, inbound AI may still fire on webhooks, but scheduled resume and campaign ticks will not.

---

## Part 6 — What must be configured for the product to work at all

Minimum viable AHL Messaging:

1. **Supabase** — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.  
2. **Public URL** — `NEXT_PUBLIC_APP_URL` (HTTPS), then rebuild.  
3. **Auth** — Google OAuth in Supabase + `NEXT_PUBLIC_ALLOWED_EMAIL_DOMAIN`.  
4. **At least one WhatsApp number** — Meta and/or Evolution and/or WAHA and/or Interakt under Settings → Numbers.  
5. **Internal tick token** — `WEBHOOK_INTERNAL_TOKEN` for campaigns, drips, automation sweep, lead distribution.  
6. **Team** — invite and approve agents; set roles and number access.

Strongly recommended next:

7. **CRM** — `LSQ_*` and/or `AHL_CRM_LEADS_URL` + `AHL_CRM_API_KEY`.  
8. **AI** — `OPENROUTER_API_KEY` or `OPENAI_API_KEY` + knowledge chunks.  
9. **Payments** — Razorpay and/or PayU keys + webhook registration.  
10. **Targets** — daily KRAs for Reports.

---

## Part 7 — Deploy reminder (so pages stay online)

Production path in the runbook: `/opt/QHT-Messaging`, PM2 name `qht-messaging`, typically port 3001 behind Nginx.

```bash
cd /opt/QHT-Messaging
git fetch origin
git reset --hard origin/main
git clean -fd
npm install
rm -rf .next
npm run build
pm2 restart qht-messaging --update-env
pm2 save
```

Never restart PM2 if the build failed. Always delete `.next` before building. After changing `.env.local`, rebuild. Hard-refresh the browser after deploy.

---

## Appendix A — Important webhook URLs (not pages, but required for features)

| Path | Feeds |
|------|--------|
| `/api/webhook` | Meta WhatsApp inbound |
| `/api/waha/webhook/[session]` | WAHA inbound (+ optional Firebase lead create) |
| `/api/evolution/webhook/[name]` | Evolution inbound |
| `/api/interakt/webhook/[secret]` | Interakt inbound |
| `/api/lsq/webhook/[secret]` | LeadSquared → drips / automation |
| `/api/lead-distribution/webhook/[secret]` | External lead ingest |
| `/api/payments/webhook/razorpay` | Razorpay paid events |
| `/api/payments/webhook/payu` | PayU paid events |
| `/api/automation/sweep` | AI resume worker (every 30s) |
| `/api/campaigns/tick` | Campaign worker (every 30s) |
| `/api/drips/tick` | Drip worker (every 30s) |
| `/api/triggers/tick` | Trigger timeouts (every 30s) |
| `/api/lead-distribution/tick` | Lead queue (every 30s) |

---

## Appendix B — Role cheat sheet

| Role | Typical access |
|------|----------------|
| owner | Everything including Data, Portfolios, Payments, AI, Embed, Ads |
| superadmin | Permissions, Calling, Numbers edit, most admin tools |
| admin | Campaigns, many settings tabs, team invite |
| teammate | Inbox and panels granted in Permissions |

Team leads (`is_team_lead`) get Reports and Team KRA even when their panel list is narrow. Monitors (`is_monitor`) affect how lead distribution treats ownership.

---

## Appendix C — Inbox tools that are not separate nav pages

These live inside `/dashboard` but matter as much as nav items:

- **Contact Details panel** — stage dropdown, lead number, assignment, labels, notes, photos, payments, refunds, AI summary / suggested reply.  
- **Composer Payment (₹)** — creates Razorpay/PayU links; needs Settings → Payments.  
- **Date Align** — booking link; needs `can_align_dates` and optional Google Calendar.  
- **Magic Message** — AI outreach text/image; needs AI keys and `can_use_magic_message`.  
- **Template send** — when the 24-hour window is closed.  
- **Stage funnel strip** — filters the list by AHL CRM stages.

---

## Appendix D — Coming soon pages (do not plan operations on these yet)

- `/widget` — website chat widget  
- `/commerce` — Meta catalogue commerce  
- `/integrations` — generic hub (use CRM and Telephony URLs instead)

---

*End of guide. This document maps every `page.tsx` route in the AHL Messaging app and every Settings tab to a business-owner explanation of purpose, UI location, and configuration.*
