// GET /api/settings/ai-prompts → editable AI system prompts + language
// PUT /api/settings/ai-prompts → save any of them
//
// Powers Settings → AI:
//   • summary  — used by /api/contacts/[id]/summary
//   • reply    — used by /api/contacts/[id]/reply-suggestion
//   • package  — used by /api/lsq/notes-summary ("Package Shared")
//   • language — output language applied to the package extract
// Owner/admin only. An empty string clears the override → default resumes.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentMember } from "@/lib/team";
import { isAtLeast } from "@/lib/team-types";
import {
  AI_REPLY_PROMPT_KEY,
  AI_SUMMARY_PROMPT_KEY,
  AI_PACKAGE_PROMPT_KEY,
  AI_OUTPUT_LANGUAGE_KEY,
  BOOKING_CONFIRM_TEMPLATE_KEY,
  BOOKING_CONFIRM_TEMPLATE_LANG_KEY,
  DEFAULT_AI_REPLY_PROMPT,
  DEFAULT_AI_SUMMARY_PROMPT,
  DEFAULT_AI_PACKAGE_PROMPT,
  getAppSetting,
  getAiOutputLanguage,
  setAppSetting,
} from "@/lib/app-settings";

export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admin or above" }, { status: 403 });
  }

  const [summaryStored, replyStored, packageStored, language, bookTpl, bookLang] =
    await Promise.all([
      getAppSetting(AI_SUMMARY_PROMPT_KEY),
      getAppSetting(AI_REPLY_PROMPT_KEY),
      getAppSetting(AI_PACKAGE_PROMPT_KEY),
      getAiOutputLanguage(),
      getAppSetting(BOOKING_CONFIRM_TEMPLATE_KEY),
      getAppSetting(BOOKING_CONFIRM_TEMPLATE_LANG_KEY),
    ]);
  const summary = summaryStored?.trim() ?? "";
  const reply = replyStored?.trim() ?? "";
  const pkg = packageStored?.trim() ?? "";

  return NextResponse.json({
    summary: {
      prompt: summary.length > 0 ? summary : DEFAULT_AI_SUMMARY_PROMPT,
      default: DEFAULT_AI_SUMMARY_PROMPT,
    },
    reply: {
      prompt: reply.length > 0 ? reply : DEFAULT_AI_REPLY_PROMPT,
      default: DEFAULT_AI_REPLY_PROMPT,
    },
    package: {
      prompt: pkg.length > 0 ? pkg : DEFAULT_AI_PACKAGE_PROMPT,
      default: DEFAULT_AI_PACKAGE_PROMPT,
    },
    language,
    booking_template: {
      name: bookTpl?.trim() ?? "",
      lang: bookLang?.trim() || "en_US",
    },
  });
}

export async function PUT(request: NextRequest) {
  const me = await getCurrentMember();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAtLeast(me.role, "admin")) {
    return NextResponse.json({ error: "Admin or above" }, { status: 403 });
  }

  let body: {
    summary?: string;
    reply?: string;
    package?: string;
    language?: string;
    booking_template_name?: string;
    booking_template_lang?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  for (const v of [body.summary, body.reply, body.package]) {
    if (typeof v === "string" && v.length > 8000) {
      return NextResponse.json(
        { error: "Prompt too long (8000 chars max)" },
        { status: 400 },
      );
    }
  }

  if (typeof body.summary === "string") {
    await setAppSetting(AI_SUMMARY_PROMPT_KEY, body.summary.trim());
  }
  if (typeof body.reply === "string") {
    await setAppSetting(AI_REPLY_PROMPT_KEY, body.reply.trim());
  }
  if (typeof body.package === "string") {
    await setAppSetting(AI_PACKAGE_PROMPT_KEY, body.package.trim());
  }
  if (typeof body.language === "string") {
    const lang = ["english", "hindi", "hinglish"].includes(body.language)
      ? body.language
      : "english";
    await setAppSetting(AI_OUTPUT_LANGUAGE_KEY, lang);
  }
  // Booking confirmation template name — lowercase/numbers/underscore only, or
  // empty to clear (falls back to plain text). Language is a Meta lang code.
  if (typeof body.booking_template_name === "string") {
    const name = body.booking_template_name.trim().toLowerCase();
    if (name && !/^[a-z0-9_]{1,512}$/.test(name)) {
      return NextResponse.json(
        { error: "Template name: lowercase letters, numbers, underscores only." },
        { status: 400 },
      );
    }
    await setAppSetting(BOOKING_CONFIRM_TEMPLATE_KEY, name);
  }
  if (typeof body.booking_template_lang === "string") {
    await setAppSetting(
      BOOKING_CONFIRM_TEMPLATE_LANG_KEY,
      body.booking_template_lang.trim() || "en_US",
    );
  }
  return NextResponse.json({ ok: true });
}
