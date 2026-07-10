"use client";

// Settings → API. Comprehensive Meta WhatsApp Cloud API reference,
// Postman-style two-column layout (description / headers / body on the
// left, copy-pastable cURL + sample response on the right).
//
// We intentionally keep the prose plain — short sentences, no jargon.
// Every endpoint here is the official Meta endpoint; replace
// {WABA_ID}, {PHONE_ID}, and {ACCESS_TOKEN} with your portfolio's
// values from .env.local.

import { useEffect, useState } from "react";
import {
  BookOpenText,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  Search,
  Webhook,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";

// ---------------------------------------------------------------------
// Endpoint catalogue — single source of truth for the right-hand pane.
// Most endpoints target our relay (${APP_BASE}/api/v1/...) so external
// integrators don't need a Meta access token. A handful (template
// management, media download) don't have a relay yet and target Meta
// directly with the portfolio access token — those are tagged
// "(Meta direct)" in the category.
// ---------------------------------------------------------------------

interface Endpoint {
  id: string;
  category: string;
  title: string;
  /** One-line plain-English summary. */
  blurb: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  notes?: string[];
  /** Optional headers list. Auth + Content-Type are added automatically. */
  body?: string;
  response?: string;
}

const API_VERSION = "v22.0";
// Relay base — replace with your deployed origin. Examples below all use
// the relay path so external integrators never see a Meta access token.
const APP_BASE = "https://wa.americanhairline.com";
const AUTH_HEADER = "Authorization: Bearer qht_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
// Used only on the few endpoints that don't have a relay yet (template
// management + media download). Show side-by-side with the relay header
// as "Meta direct (advanced)".
const META_AUTH_HEADER = "Authorization: Bearer {META_ACCESS_TOKEN}";

const ENDPOINTS: Endpoint[] = [
  // --- AUTH / SETUP ---------------------------------------------------
  {
    id: "auth",
    category: "Setup",
    title: "Verify your API token (health check)",
    blurb:
      "Sanity-check a fresh token before wiring it into anything. Returns the WhatsApp number this token is bound to.",
    method: "GET",
    path: `${APP_BASE}/api/v1/me`,
    notes: [
      "Generate a token first under Settings → Numbers → API tokens.",
      "200 → token works. 401 → token missing / invalid / paused.",
      "The token decides which WhatsApp number sends — no need to pass it in the URL on other endpoints.",
    ],
    response: `{
  "ok": true,
  "token": { "id": "uuid", "name": "n8n booking flow" },
  "business_phone_number_id": "1150287611490963",
  "number": {
    "phone_number_id": "1150287611490963",
    "display_phone_number": "+91 90847 23091",
    "verified_name": "URoots by QHT",
    "nickname": "URoots"
  }
}`,
  },

  // --- TEXT MESSAGES --------------------------------------------------
  {
    id: "send-text",
    category: "Send messages",
    title: "Send a text message",
    blurb:
      "Plain text reply. Only works inside the 24-hour customer-service window — outside that window, use a template instead.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "text",
  "text": {
    "preview_url": false,
    "body": "Hi! How can we help?"
  }
}`,
    response: `{
  "messaging_product": "whatsapp",
  "contacts": [{ "input": "919876543210", "wa_id": "919876543210" }],
  "messages": [{ "id": "wamid.HBgM..." }]
}`,
    notes: [
      "to — phone in E.164 format without the +.",
      "preview_url: true → WhatsApp shows a link preview if the body has a URL.",
    ],
  },

  // --- TEMPLATES ------------------------------------------------------
  {
    id: "send-template",
    category: "Send messages",
    title: "Send an approved template (no variables)",
    blurb:
      "Send a pre-approved template by name. Use this when the 24h window is closed or you're starting a fresh conversation.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "template",
  "template": {
    "name": "hello_world",
    "language": { "code": "en_US" }
  }
}`,
    response: `{
  "messaging_product": "whatsapp",
  "contacts": [{ "input": "919876543210", "wa_id": "919876543210" }],
  "messages": [{ "id": "wamid.HBgM..." }]
}`,
    notes: [
      "name — exact template name as approved in Meta's WA Manager.",
      "language.code — must match the approved language (en_US, en, hi, etc.).",
    ],
  },
  {
    id: "send-template-with-vars",
    category: "Send messages",
    title: "Template with body variables",
    blurb:
      "Pass variables for {{1}}, {{2}}, ... placeholders in the template body.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "template",
  "template": {
    "name": "appointment_reminder",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Mohd Khushnaseeb" },
          { "type": "text", "text": "Tuesday, 12 May at 4:00 PM" }
        ]
      }
    ]
  }
}`,
    response: `{
  "messages": [{ "id": "wamid.HBgM..." }]
}`,
    notes: [
      "Order of parameters must match {{1}}, {{2}}, ... in the template body.",
      "Each parameter is a separate object with type + text/currency/date_time.",
    ],
  },
  {
    id: "send-template-image-header",
    category: "Send messages",
    title: "Template with image header",
    blurb:
      "Approved template that has an IMAGE in its header — useful for the magic_message style cards. Upload your image first to get a media_id.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "template",
  "template": {
    "name": "magic_message",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "header",
        "parameters": [
          { "type": "image", "image": { "id": "{MEDIA_ID}" } }
        ]
      },
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Mohd Khushnaseeb" }
        ]
      }
    ]
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
    notes: [
      "image.id — media_id from the Upload media endpoint.",
      "Or use { \"image\": { \"link\": \"https://...\" } } to pass a public URL instead.",
    ],
  },
  {
    id: "send-template-doc-header",
    category: "Send messages",
    title: "Template with document header",
    blurb: "PDF / DOCX in the template header. Pass media_id or a public link.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "template",
  "template": {
    "name": "invoice_template",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "header",
        "parameters": [
          {
            "type": "document",
            "document": {
              "id": "{MEDIA_ID}",
              "filename": "invoice-may.pdf"
            }
          }
        ]
      }
    ]
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
  },
  {
    id: "send-template-video-header",
    category: "Send messages",
    title: "Template with video header",
    blurb: "MP4 video header for templates that were approved with a video header.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "template",
  "template": {
    "name": "promo_video",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "header",
        "parameters": [
          { "type": "video", "video": { "id": "{MEDIA_ID}" } }
        ]
      }
    ]
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
  },
  {
    id: "send-template-button-url",
    category: "Send messages",
    title: "Template with body vars + dynamic URL button",
    blurb:
      "Real-world template: body has {{1}} {{2}} placeholders AND a CTA URL button whose URL contains {{1}}. Send ALL component parameters in one call — missing any one of them returns Meta error 135000 'Generic user error'.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "to": "919876543210",
  "type": "template",
  "template": {
    "name": "order_confirmation_v6",
    "language": { "code": "en_US" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "12893" },
          { "type": "text", "text": "5-7 working days" }
        ]
      },
      {
        "type": "button",
        "sub_type": "url",
        "index": "0",
        "parameters": [
          { "type": "text", "text": "12893" }
        ]
      }
    ]
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
    notes: [
      "Include EVERY component the template defines (header / body / button) — Meta rejects partial payloads with 135000.",
      "Quick-reply buttons don't need any parameters at send time — only URL / Phone buttons with {{...}} placeholders do.",
      "button.index — 0 for the first button, 1 for the second, etc.",
      "Avoid special chars in body params if you hit 135000 (e.g. send '12893' not '#12893').",
    ],
  },

  // --- MEDIA SENDS ----------------------------------------------------
  {
    id: "send-image",
    category: "Send messages",
    title: "Send an image",
    blurb:
      "Free-form image (inside 24h window). Pass a media_id you uploaded earlier or a public URL.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "image",
  "image": {
    "id": "{MEDIA_ID}",
    "caption": "Sample photo from salon"
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
  },
  {
    id: "send-video",
    category: "Send messages",
    title: "Send a video",
    blurb: "MP4 video (inside 24h window). Optional caption.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "video",
  "video": {
    "id": "{MEDIA_ID}",
    "caption": "Procedure walkthrough"
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
  },
  {
    id: "send-document",
    category: "Send messages",
    title: "Send a document",
    blurb: "PDF / DOCX / XLSX. Always pass a filename the user will see.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "document",
  "document": {
    "id": "{MEDIA_ID}",
    "filename": "treatment-plan.pdf",
    "caption": "Your treatment plan"
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
  },
  {
    id: "send-audio",
    category: "Send messages",
    title: "Send an audio / voice note",
    blurb: "Audio file. WhatsApp shows it as a voice note.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "audio",
  "audio": { "id": "{MEDIA_ID}" }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
  },
  {
    id: "send-sticker",
    category: "Send messages",
    title: "Send a sticker",
    blurb: "WebP sticker. Animated stickers also use this endpoint.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "sticker",
  "sticker": { "id": "{MEDIA_ID}" }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
  },

  // --- INTERACTIVE ----------------------------------------------------
  {
    id: "send-buttons",
    category: "Interactive",
    title: "Reply buttons (up to 3)",
    blurb:
      "Quick-reply buttons. User taps one, you receive an inbound message of type interactive with the button id.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "body": { "text": "Are you ready to book your consultation?" },
    "action": {
      "buttons": [
        { "type": "reply", "reply": { "id": "yes_book", "title": "Yes, book" } },
        { "type": "reply", "reply": { "id": "later", "title": "Later" } },
        { "type": "reply", "reply": { "id": "no_thanks", "title": "No thanks" } }
      ]
    }
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
    notes: [
      "Each button title must be ≤ 20 characters.",
      "id — your own opaque value, returned to you in the inbound webhook.",
    ],
  },
  {
    id: "send-list",
    category: "Interactive",
    title: "List picker (up to 10)",
    blurb:
      "Drop-down list of options. Better than buttons when you have more than 3 choices.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "interactive",
  "interactive": {
    "type": "list",
    "body": { "text": "Pick a salon to book at:" },
    "action": {
      "button": "Choose salon",
      "sections": [
        {
          "title": "North India",
          "rows": [
            { "id": "delhi", "title": "Khar West" },
            { "id": "haridwar", "title": "Mumbai" }
          ]
        },
        {
          "title": "South India",
          "rows": [
            { "id": "hyderabad", "title": "Mumbai" }
          ]
        }
      ]
    }
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
  },
  {
    id: "send-reaction",
    category: "Interactive",
    title: "React with an emoji",
    blurb: "Add an emoji reaction to a message you previously received.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "reaction",
  "reaction": {
    "message_id": "wamid.HBgMOTE5MDg0NzIzMDkxFQIAEhggMTIzNDU2Nzg5MA==",
    "emoji": "❤️"
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
    notes: [
      "Set emoji to \"\" (empty) to remove a reaction.",
    ],
  },
  {
    id: "send-location",
    category: "Interactive",
    title: "Send a location pin",
    blurb: "Static lat/long with a label.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "location",
  "location": {
    "latitude": 28.6139,
    "longitude": 77.2090,
    "name": "AHL Khar West Salon",
    "address": "Khar West, Mumbai"
  }
}`,
    response: `{ "messages": [{ "id": "wamid.HBgM..." }] }`,
  },

  // --- READ + TYPING --------------------------------------------------
  {
    id: "mark-read",
    category: "Status",
    title: "Mark a message as read (blue ticks)",
    blurb:
      "Tell Meta the user's message has been seen. Optionally include typing_indicator to show 'typing…' on the user's screen.",
    method: "POST",
    path: `${APP_BASE}/api/v1/messages`,
    body: `{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "wamid.HBgMOTE5MDg0NzIzMDkxFQIAEhggMTIzNDU2Nzg5MA==",
  "typing_indicator": { "type": "text" }
}`,
    response: `{ "success": true }`,
    notes: [
      "typing_indicator is optional — drop it if you only want the read receipt.",
    ],
  },

  // --- MEDIA UPLOAD / DOWNLOAD ----------------------------------------
  {
    id: "upload-media",
    category: "Media",
    title: "Upload media",
    blurb:
      "Upload a file and get back a media_id you can pass to any send-message call. Multipart form, not JSON. Same Bearer token as /messages.",
    method: "POST",
    path: `${APP_BASE}/api/v1/media`,
    body: `# Multipart form fields:
type   = image/jpeg          (or image/png, video/mp4, audio/ogg, application/pdf, image/webp …)
file   = @/path/to/file.jpg`,
    response: `{ "id": "1234567890" }`,
    notes: [
      "Send Content-Type as multipart/form-data — do NOT JSON-encode.",
      "Returned id is valid for 30 days; re-upload after that.",
      "messaging_product is auto-injected, you don't need to pass it.",
    ],
  },
  {
    id: "get-media-url",
    category: "Media (Meta direct)",
    title: "Get a media download URL",
    blurb:
      "No relay yet — call Meta directly with the portfolio access token. Given a media_id (from an inbound webhook), fetch the short-lived download URL.",
    method: "GET",
    path: `https://graph.facebook.com/${API_VERSION}/{MEDIA_ID}`,
    response: `{
  "url": "https://lookaside.fbsbx.com/whatsapp_business/...",
  "mime_type": "image/jpeg",
  "sha256": "...",
  "file_size": 124234,
  "id": "1234567890",
  "messaging_product": "whatsapp"
}`,
    notes: [
      "Use META_ACCESS_TOKEN here, not the qht_ token.",
      "The url expires in ~5 minutes. Download immediately, then mirror to your own storage if you need to keep it.",
      "When downloading, pass the same Authorization: Bearer header — Meta media URLs are private.",
    ],
  },
  {
    id: "delete-media",
    category: "Media (Meta direct)",
    title: "Delete uploaded media",
    blurb: "Optional cleanup of a media_id you uploaded. Meta direct — uses the portfolio access token.",
    method: "DELETE",
    path: `https://graph.facebook.com/${API_VERSION}/{MEDIA_ID}`,
    response: `{ "success": true }`,
    notes: ["Use META_ACCESS_TOKEN here, not the qht_ token."],
  },

  // --- TEMPLATES MANAGEMENT -------------------------------------------
  {
    id: "list-templates",
    category: "Templates (Meta direct)",
    title: "List your templates",
    blurb: "No relay yet — call Meta directly. Read every template attached to your WhatsApp Business Account.",
    notes: ["Use META_ACCESS_TOKEN here, not the qht_ token."],
    method: "GET",
    path: `https://graph.facebook.com/${API_VERSION}/{WABA_ID}/message_templates?limit=200`,
    response: `{
  "data": [
    {
      "name": "magic_message",
      "language": "en_US",
      "status": "APPROVED",
      "category": "UTILITY",
      "components": [ /* header, body, footer, buttons */ ]
    }
  ],
  "paging": { "cursors": { "before": "...", "after": "..." } }
}`,
  },
  {
    id: "create-template",
    category: "Templates (Meta direct)",
    title: "Create a new template (submit for review)",
    blurb:
      "No relay yet — call Meta directly. Submit a template for Meta's approval. They typically review within minutes.",
    method: "POST",
    path: `https://graph.facebook.com/${API_VERSION}/{WABA_ID}/message_templates`,
    body: `{
  "name": "appointment_reminder",
  "language": "en_US",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Hi {{1}}, your appointment is on {{2}}.",
      "example": {
        "body_text": [["Mohd", "Tue 12 May, 4 PM"]]
      }
    }
  ]
}`,
    response: `{
  "id": "1234567890",
  "status": "PENDING",
  "category": "UTILITY"
}`,
    notes: [
      "Use META_ACCESS_TOKEN here, not the qht_ token.",
      "Categories: MARKETING, UTILITY, AUTHENTICATION.",
      "MARKETING templates need explicit user opt-in; UTILITY can be sent for transactional updates.",
    ],
  },
  {
    id: "delete-template",
    category: "Templates (Meta direct)",
    title: "Delete a template",
    blurb: "No relay yet — call Meta directly. Remove a template by name.",
    method: "DELETE",
    path: `https://graph.facebook.com/${API_VERSION}/{WABA_ID}/message_templates?name=appointment_reminder`,
    response: `{ "success": true }`,
    notes: ["Use META_ACCESS_TOKEN here, not the qht_ token."],
  },

  // --- WEBHOOKS (FROM META TO YOUR APP) -------------------------------
  {
    id: "webhook-verify",
    category: "Webhooks (Meta → app)",
    title: "Verify your webhook URL",
    blurb:
      "First call from Meta when you save a webhook URL. Echo the challenge back to confirm you own the endpoint.",
    method: "GET",
    path: "https://your-app.example.com/api/webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...",
    response: `# Plain-text response, not JSON:

<the value of hub.challenge>`,
    notes: [
      "If hub.verify_token matches the one you saved on Meta, return 200 + the challenge string.",
      "Otherwise return 403.",
    ],
  },
  {
    id: "webhook-inbound",
    category: "Webhooks (Meta → app)",
    title: "Inbound message payload",
    blurb: "What Meta POSTs when a user messages your number.",
    method: "POST",
    path: "https://your-app.example.com/api/webhook",
    body: `# This is what Meta sends TO your endpoint (not what you send to Meta).
# You should respond with 200 OK quickly — process async.`,
    response: `{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "{WABA_ID}",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "+91 90847 23091",
          "phone_number_id": "{PHONE_ID}"
        },
        "contacts": [{
          "profile": { "name": "Mohd" },
          "wa_id": "919876543210"
        }],
        "messages": [{
          "from": "919876543210",
          "id": "wamid.HBgM...",
          "timestamp": "1762668222",
          "type": "text",
          "text": { "body": "hi" }
        }]
      }
    }]
  }]
}`,
  },
  {
    id: "webhook-status",
    category: "Webhooks (Meta → app)",
    title: "Status update payload",
    blurb:
      "Sent / delivered / read / failed events for messages you previously sent.",
    method: "POST",
    path: "https://your-app.example.com/api/webhook",
    response: `{
  "entry": [{
    "changes": [{
      "value": {
        "metadata": { "phone_number_id": "{PHONE_ID}" },
        "statuses": [{
          "id": "wamid.HBgMOTE5MDg0NzIzMDkxFQIAEhggMTIzNDU2Nzg5MA==",
          "status": "delivered",
          "timestamp": "1762668255",
          "recipient_id": "919876543210"
        }]
      }
    }]
  }]
}`,
  },
];

// ---------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------
export function ApiDocsView() {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? ENDPOINTS.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.blurb.toLowerCase().includes(q) ||
          e.category.toLowerCase().includes(q) ||
          e.path.toLowerCase().includes(q),
      )
    : ENDPOINTS;
  // Always show Quick start + Outbound webhooks unless they're explicitly
  // searched away — keeps the page useful even with a stray query.
  const showQuickStart =
    !q || "quick start auth setup".includes(q) || "setup".includes(q);
  const showOutbound =
    !q || "outbound webhook hmac signature".includes(q) || "webhook".includes(q);

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <SettingsPageHeader
        icon={BookOpenText}
        tone="sky"
        title="API & integrations"
        subtitle="Meta WhatsApp Cloud API reference, in plain English. Same endpoints Meta documents — picked, simplified, and laid out side-by-side."
        right={
          <a
            href="https://developers.facebook.com/docs/whatsapp/cloud-api"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
          >
            Meta&apos;s official docs <ExternalLink className="h-3 w-3" />
          </a>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid max-w-7xl gap-8 px-8 py-8 lg:grid-cols-[280px_1fr]">
          <SidebarNav endpoints={filtered} query={query} setQuery={setQuery} />
          <div className="min-w-0 space-y-10">
            <ApiHealthMonitor />
            {showQuickStart ? <QuickStart /> : null}
            {showOutbound ? <OutboundWebhookSection /> : null}
            {filtered.map((e) => (
              <EndpointBlock key={e.id} endpoint={e} />
            ))}
            {q && filtered.length === 0 && !showQuickStart && !showOutbound ? (
              <div className="rounded-2xl border border-dashed bg-card/50 px-8 py-12 text-center text-sm text-muted-foreground">
                No endpoints match &ldquo;{query}&rdquo;.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Left rail — categories with anchor links to each endpoint.
// ---------------------------------------------------------------------
function SidebarNav({
  endpoints,
  query,
  setQuery,
}: {
  endpoints: Endpoint[];
  query: string;
  setQuery: (v: string) => void;
}) {
  const groups = endpoints.reduce<Record<string, Endpoint[]>>((acc, e) => {
    (acc[e.category] ||= []).push(e);
    return acc;
  }, {});
  return (
    <nav className="hidden lg:sticky lg:top-4 lg:block lg:self-start">
      {/* Search box stays pinned on top of the rail; the link list below
          scrolls independently so the rail never spills below the
          viewport on long doc pages. */}
      <div className="flex max-h-[calc(100vh-7rem)] flex-col rounded-xl border bg-card text-sm shadow-sm">
        <div className="border-b p-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search endpoints…"
              className="w-full rounded-md border bg-background py-1.5 pl-8 pr-7 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {!query ? (
            <>
              <a
                href="#quick-start"
                className="block rounded-md px-2.5 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-secondary"
              >
                Quick start
              </a>
              <a
                href="#outbound-webhooks"
                className="block rounded-md px-2.5 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-secondary"
              >
                Our outbound webhooks
              </a>
            </>
          ) : null}

          {Object.entries(groups).map(([cat, items]) => (
            <div key={cat} className="mt-3 first:mt-0">
              <div className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {cat}
              </div>
              <div className="space-y-0.5">
                {items.map((e) => (
                  <a
                    key={e.id}
                    href={`#${e.id}`}
                    className="flex items-center gap-1.5 truncate rounded-md px-2.5 py-1.5 text-[13px] text-foreground/70 hover:bg-secondary hover:text-foreground"
                  >
                    <ChevronRight className="h-3 w-3 shrink-0" />
                    <span className="truncate">{e.title}</span>
                  </a>
                ))}
              </div>
            </div>
          ))}

          {query && endpoints.length === 0 ? (
            <p className="px-2.5 py-3 text-xs text-muted-foreground">
              No matches.
            </p>
          ) : null}
        </div>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------
// Quick start panel — auth, env vars, base URL.
// ---------------------------------------------------------------------
function QuickStart() {
  return (
    <section id="quick-start" className="scroll-mt-4 overflow-hidden rounded-2xl border bg-card shadow-sm">
      <header className="flex items-center gap-2.5 border-b bg-secondary/30 px-5 py-3.5">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200">
          <KeyRound className="h-4 w-4" />
        </span>
        <h3 className="text-base font-semibold tracking-tight">Quick start</h3>
      </header>
      <div className="grid gap-5 px-5 py-5 md:grid-cols-2">
        <div className="space-y-3 text-[15px] text-foreground/85">
          <p>
            Most examples below use <strong>this app&apos;s relay</strong> at{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-sm">
              {APP_BASE}/api/v1
            </code>
            . You don&apos;t need a Meta access token — just an API token
            generated under Settings → Numbers → API tokens.
          </p>
          <p>Replace these placeholders in every example:</p>
          <ul className="ml-5 list-disc space-y-1.5 text-sm">
            <li>
              <code className="font-mono">qht_xxxx…</code> — your API token. Determines
              which WhatsApp number sends.
            </li>
            <li>
              <code className="font-mono">{`{MEDIA_ID}`}</code> — id returned by the
              Upload media call.
            </li>
          </ul>
          <p className="text-sm text-muted-foreground">
            A few endpoints don&apos;t have a relay yet (template management,
            media download). Those are tagged{" "}
            <em>(Meta direct)</em> and use{" "}
            <code className="font-mono">{`{META_ACCESS_TOKEN}`}</code> instead.
          </p>
        </div>
        <CodeBlock language="bash">
          {`# Curl skeleton used by every example below
curl -X POST '${APP_BASE}/api/v1/messages' \\
  -H '${AUTH_HEADER}' \\
  -H 'Content-Type: application/json' \\
  -d '{ ... json body ... }'`}
        </CodeBlock>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
// Our outbound webhook docs (events FROM this app TO your URL).
// ---------------------------------------------------------------------
function OutboundWebhookSection() {
  return (
    <section
      id="outbound-webhooks"
      className="scroll-mt-4 overflow-hidden rounded-2xl border bg-card shadow-sm"
    >
      <header className="flex items-center gap-2.5 border-b bg-secondary/30 px-5 py-3.5">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200">
          <Webhook className="h-4 w-4" />
        </span>
        <h3 className="text-base font-semibold tracking-tight">
          Our outbound webhooks (this app → your URL)
        </h3>
      </header>
      <div className="grid gap-5 px-5 py-5 md:grid-cols-2">
        <div className="space-y-3 text-[15px] text-foreground/85">
          <p>
            Different from Meta&apos;s webhooks. These are events <strong>this
            app</strong> fires to URLs you registered under Settings →
            Numbers → Webhooks. Use them in n8n, Make, or any HTTP server.
          </p>
          <ul className="ml-5 list-disc space-y-1.5 text-sm">
            <li>
              Headers: <code>X-QHT-Event</code>,{" "}
              <code>X-QHT-Signature: sha256=&lt;hex&gt;</code>
            </li>
            <li>HMAC-SHA256 over the raw body, with the per-webhook secret.</li>
            <li>
              Event types: <code>message.inbound</code>, <code>message.status</code>,{" "}
              <code>call.event</code>.
            </li>
            <li>Fire-and-forget — we do not retry. Acknowledge with 200 fast.</li>
          </ul>
        </div>
        <CodeBlock language="javascript">
          {`// Verify in Node.js
import crypto from "crypto";
function ok(rawBody, headers, secret) {
  const got = headers["x-qht-signature"];
  const exp = "sha256=" + crypto
    .createHmac("sha256", secret).update(rawBody).digest("hex");
  return got && got.length === exp.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(exp));
}`}
        </CodeBlock>
      </div>
      <div className="grid gap-5 border-t px-5 py-5 md:grid-cols-2">
        <div className="text-sm text-foreground/85">
          <strong>message.inbound</strong> — customer messaged your number.
        </div>
        <CodeBlock language="json">
          {`{
  "type": "message.inbound",
  "business_phone_number_id": "{PHONE_ID}",
  "occurred_at": "2026-05-09T10:03:42Z",
  "data": {
    "wa_id": "919876543210",
    "wa_message_id": "wamid.HBgM...",
    "type": "text",
    "profile_name": "Mohd",
    "raw": { /* original Meta inbound */ }
  }
}`}
        </CodeBlock>
      </div>
      <div className="grid gap-5 border-t px-5 py-5 md:grid-cols-2">
        <div className="text-sm text-foreground/85">
          <strong>message.status</strong> — sent / delivered / read / failed.
        </div>
        <CodeBlock language="json">
          {`{
  "type": "message.status",
  "business_phone_number_id": "{PHONE_ID}",
  "occurred_at": "2026-05-09T10:04:15Z",
  "data": {
    "wa_message_id": "wamid.HBgM...",
    "status": "delivered",
    "error": null,
    "raw": { /* original Meta status */ }
  }
}`}
        </CodeBlock>
      </div>
      <div className="grid gap-5 border-t px-5 py-5 md:grid-cols-2">
        <div className="text-sm text-foreground/85">
          <strong>call.event</strong> — WhatsApp Cloud Calling state change.
        </div>
        <CodeBlock language="json">
          {`{
  "type": "call.event",
  "business_phone_number_id": "{PHONE_ID}",
  "occurred_at": "2026-05-09T10:05:00Z",
  "data": {
    "wa_call_id": "wacid....",
    "event": "accept",        // connect | accept | reject | terminate
    "status": "accepted",     // ringing | accepted | rejected | terminated | missed
    "direction": "inbound",
    "from": "919876543210",
    "to": null,
    "raw": { /* original Meta call */ }
  }
}`}
        </CodeBlock>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------
// Endpoint card — Postman-style two columns.
//   Left:  description + headers + body
//   Right: cURL + sample response
// ---------------------------------------------------------------------
function EndpointBlock({ endpoint }: { endpoint: Endpoint }) {
  const isMetaDirect = endpoint.path.startsWith("https://graph.facebook.com/");
  const authHeader = isMetaDirect ? META_AUTH_HEADER : AUTH_HEADER;
  const curl = buildCurl(endpoint, authHeader);
  return (
    <section
      id={endpoint.id}
      className="scroll-mt-4 overflow-hidden rounded-2xl border bg-card shadow-sm"
    >
      <header className="flex flex-wrap items-center gap-2.5 border-b bg-secondary/30 px-5 py-3.5">
        <MethodPill method={endpoint.method} />
        <h3 className="text-base font-semibold tracking-tight">{endpoint.title}</h3>
        <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
          {endpoint.path.replace(/^https:\/\/graph\.facebook\.com/, "")}
        </span>
      </header>
      <div className="grid gap-0 md:grid-cols-2">
        {/* Left: prose + headers + body */}
        <div className="space-y-4 border-b px-5 py-5 text-[15px] md:border-b-0 md:border-r">
          <p className="text-foreground/85">{endpoint.blurb}</p>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Headers
            </div>
            <ul className="space-y-1 text-sm">
              <li className="font-mono">{authHeader}</li>
              {endpoint.method !== "GET" && endpoint.body ? (
                <li className="font-mono">Content-Type: application/json</li>
              ) : null}
            </ul>
          </div>

          {endpoint.body ? (
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Body
              </div>
              <CodeBlock language={endpoint.body.startsWith("#") ? "bash" : "json"}>
                {endpoint.body}
              </CodeBlock>
            </div>
          ) : null}

          {endpoint.notes && endpoint.notes.length > 0 ? (
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Notes
              </div>
              <ul className="ml-5 list-disc space-y-1 text-sm text-foreground/80">
                {endpoint.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {/* Right: curl + response */}
        <div className="space-y-4 px-5 py-5">
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Example request
            </div>
            <CodeBlock language="bash">{curl}</CodeBlock>
          </div>
          {endpoint.response ? (
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Example response
              </div>
              <CodeBlock language="json">{endpoint.response}</CodeBlock>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function buildCurl(e: Endpoint, authHeader: string): string {
  const method = e.method;
  const lines: string[] = [`curl -X ${method} '${e.path}' \\`, `  -H '${authHeader}'`];
  if (method !== "GET" && e.body && !e.body.startsWith("#")) {
    lines[lines.length - 1] += " \\";
    lines.push(`  -H 'Content-Type: application/json' \\`);
    const json = e.body.replace(/'/g, "'\\''");
    lines.push(`  -d '${json}'`);
  }
  if (method !== "GET" && e.body && e.body.startsWith("#")) {
    // Multipart upload — show -F lines based on the documented form
    // fields. The relay injects messaging_product itself, so we don't
    // include it in the example.
    lines[lines.length - 1] += " \\";
    lines.push(`  -F 'type=image/jpeg' \\`);
    lines.push(`  -F 'file=@/path/to/file.jpg'`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Tiny shared bits.
// ---------------------------------------------------------------------
function MethodPill({ method }: { method: Endpoint["method"] }) {
  const tones: Record<Endpoint["method"], string> = {
    GET: "bg-sky-100 text-sky-800 ring-sky-200",
    POST: "bg-primary/15 text-primary ring-primary/25",
    DELETE: "bg-rose-100 text-rose-800 ring-rose-200",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs font-bold ring-1 ring-inset",
        tones[method],
      )}
    >
      {method}
    </span>
  );
}

function CodeBlock({
  language,
  children,
}: {
  language: string;
  children: string;
}) {
  const [copied, setCopied] = useState(false);
  // Reset the "Copied" label whenever the content changes (e.g. tab switch).
  useEffect(() => setCopied(false), [children]);
  function copy() {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="group relative overflow-hidden rounded-lg border bg-slate-950 text-[13px] text-slate-100">
      <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2">
        <span className="font-mono text-[11px] uppercase tracking-wide text-white/60">
          {language}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-xs font-medium text-white/80 hover:bg-white/15"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-[#6098FF]" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono leading-relaxed">{children}</pre>
    </div>
  );
}

// ---------------------------------------------------------------------
// API health monitor — per-day request volume, where the hits are
// actually coming from (platform inferred from User-Agent), and a
// recent-call audit log. Lets the operator see at a glance if n8n
// suddenly stopped firing, if a stale Postman test is hammering the
// server, or which integrator pushed the most templates yesterday.
// ---------------------------------------------------------------------
interface StatsResponse {
  window_days: number;
  total_requests: number;
  errors: number;
  per_day: Array<{ day: string; total: number; errors: number }>;
  per_platform: Array<{ platform: string; count: number }>;
  per_token: Array<{ id: string; name: string; count: number }>;
  tokens: Array<{
    id: string;
    name: string;
    business_phone_number_id: string;
    request_count: number | null;
    last_used_at: string | null;
    enabled: boolean;
  }>;
  recent: Array<{
    id: string;
    occurred_at: string;
    method: string;
    path: string;
    status: number;
    duration_ms: number | null;
    token_name: string | null;
    business_phone_number_id: string | null;
    platform: string;
    user_agent: string | null;
    source_ip: string | null;
  }>;
}

function ApiHealthMonitor() {
  const [days, setDays] = useState<7 | 14 | 30>(7);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`/api/api-stats?days=${days}`, { cache: "no-store" })
        .then(async (r) => {
          const j = await r.json().catch(() => null);
          if (cancelled) return;
          if (!r.ok) {
            setErr((j as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
            return;
          }
          setErr(null);
          setStats(j as StatsResponse);
        })
        .catch((e) => {
          if (cancelled) return;
          setErr(e instanceof Error ? e.message : "Network error");
        });
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [days]);

  const maxDayTotal = stats
    ? Math.max(1, ...stats.per_day.map((d) => d.total))
    : 1;

  return (
    <section
      id="api-health"
      className="rounded-2xl border bg-card p-5 shadow-sm"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold leading-tight">
            API health monitor
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Live request volume + per-platform breakdown. Counts every
            authenticated call to <code className="font-mono text-[10px]">/api/v1/*</code>.
          </p>
        </div>
        <div className="inline-flex rounded-md border bg-background p-0.5 text-[11px]">
          {([7, 14, 30] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setDays(n)}
              className={cn(
                "rounded-sm px-2 py-1 font-semibold transition",
                days === n
                  ? "bg-sky-600 text-white"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              Last {n}d
            </button>
          ))}
        </div>
      </div>

      {err ? (
        <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {err}
          {err.toLowerCase().includes("relation") ||
          err.toLowerCase().includes("does not exist") ? (
            <span className="ml-1">
              · Run migration{" "}
              <code className="font-mono">0044_api_request_log.sql</code>.
            </span>
          ) : null}
        </div>
      ) : null}

      {stats ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Total requests" value={stats.total_requests.toLocaleString()} />
            <Stat
              label="Errors"
              value={stats.errors.toLocaleString()}
              accent={stats.errors > 0 ? "rose" : undefined}
            />
            <Stat
              label="Success rate"
              value={
                stats.total_requests === 0
                  ? "—"
                  : `${Math.round(((stats.total_requests - stats.errors) / stats.total_requests) * 100)}%`
              }
            />
            <Stat
              label="Active tokens"
              value={String(stats.tokens.filter((t) => t.enabled).length)}
            />
          </div>

          {/* Per-day sparkline */}
          <div className="mb-5 rounded-lg border bg-background p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Daily requests
            </p>
            <div className="flex items-end gap-1">
              {stats.per_day.map((d) => {
                const h = Math.max(
                  4,
                  Math.round((d.total / maxDayTotal) * 80),
                );
                return (
                  <div
                    key={d.day}
                    className="flex flex-1 flex-col items-center gap-1"
                    title={`${d.day} · ${d.total} req · ${d.errors} err`}
                  >
                    <div
                      className={cn(
                        "w-full rounded-t",
                        d.errors > 0 ? "bg-rose-400" : "bg-sky-500",
                      )}
                      style={{ height: `${h}px` }}
                    />
                    <span className="text-[9px] text-muted-foreground">
                      {d.day.slice(5)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* Per-platform */}
            <div className="rounded-lg border bg-background p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Where calls are coming from
              </p>
              {stats.per_platform.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No data yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {stats.per_platform.map((p) => {
                    const pct = Math.round(
                      (p.count / Math.max(1, stats.total_requests)) * 100,
                    );
                    return (
                      <li key={p.platform} className="text-[11px]">
                        <div className="mb-0.5 flex items-center justify-between">
                          <span className="font-semibold">{p.platform}</span>
                          <span className="text-muted-foreground">
                            {p.count.toLocaleString()} · {pct}%
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full bg-sky-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Per-token */}
            <div className="rounded-lg border bg-background p-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Per token (in window)
              </p>
              {stats.per_token.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No data yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {stats.per_token.map((t) => (
                    <li
                      key={t.id}
                      className="flex items-center justify-between text-[11px]"
                    >
                      <span className="truncate font-semibold">{t.name}</span>
                      <span className="text-muted-foreground">
                        {t.count.toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Recent hits */}
          <div className="mt-5 rounded-lg border bg-background">
            <div className="border-b px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Last {Math.min(50, stats.recent.length)} requests
              </p>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {stats.recent.length === 0 ? (
                <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  No requests yet.
                </p>
              ) : (
                <table className="w-full text-[11px]">
                  <thead className="border-b bg-secondary/40 text-left text-[9px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5">When</th>
                      <th className="px-2 py-1.5">Method</th>
                      <th className="px-2 py-1.5">Path</th>
                      <th className="px-2 py-1.5">Status</th>
                      <th className="px-2 py-1.5">Token</th>
                      <th className="px-2 py-1.5">From</th>
                      <th className="px-2 py-1.5 text-right">Dur</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {stats.recent.map((r) => (
                      <tr
                        key={r.id}
                        className={cn(r.status >= 400 && "bg-rose-50/40")}
                      >
                        <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted-foreground">
                          {new Date(r.occurred_at).toLocaleString()}
                        </td>
                        <td className="px-2 py-1.5 font-mono font-semibold">
                          {r.method}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-muted-foreground">
                          {r.path}
                        </td>
                        <td className="px-2 py-1.5">
                          <span
                            className={cn(
                              "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                              r.status >= 500
                                ? "bg-rose-100 text-rose-800"
                                : r.status >= 400
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-primary/15 text-primary",
                            )}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td className="px-2 py-1.5">{r.token_name ?? "—"}</td>
                        <td className="px-2 py-1.5">
                          <span
                            title={r.user_agent ?? ""}
                            className="cursor-help underline decoration-dotted"
                          >
                            {r.platform}
                          </span>
                          {r.source_ip ? (
                            <span className="ml-1 font-mono text-[9px] text-muted-foreground">
                              {r.source_ip}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">
                          {r.duration_ms != null ? `${r.duration_ms}ms` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      ) : err ? null : (
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "rose";
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-background px-3 py-2",
        accent === "rose" && "border-rose-200 bg-rose-50/40",
      )}
    >
      <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 text-lg font-bold tracking-tight",
          accent === "rose" && "text-rose-700",
        )}
      >
        {value}
      </p>
    </div>
  );
}
