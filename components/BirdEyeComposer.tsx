"use client";

// Full inbox composer embedded inside a bird's-eye chat panel. Wraps the same
// MessageInput the inbox uses (text / quick replies / templates / media / voice
// / notes / emoji), wiring its handlers straight to /api/send-message via the
// logged-in session. Templates needing variables/media open the full chat.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MessageInput } from "@/components/MessageInput";
import type { ComposerMode } from "@/components/ComposerTabs";
import type { QuickReply } from "@/components/QuickRepliesManager";
import type { TemplateSummary } from "@/components/TemplatePicker";
import { addContactNoteAction } from "@/app/(dashboard)/actions";

interface PanelContact {
  id: string;
  wa_id: string | null;
  business_phone_number_id: string | null;
  window_open?: boolean;
}

export function BirdEyeComposer({ contact, onSent }: { contact: PanelContact; onSent: () => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<ComposerMode>("reply");

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contact.id, wa_id: contact.wa_id, ...body }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ?? "Send failed");
    }
    onSent();
  }

  async function onSend(text: string) {
    await post({ text });
  }

  async function onSaveNote(text: string) {
    const r = await addContactNoteAction(contact.id, text);
    if ("error" in r) throw new Error(r.error);
  }

  async function onSendRich(q: QuickReply) {
    await post({
      kind: "rich",
      text: q.body,
      media_url: q.media_url ?? undefined,
      media_kind: q.media_kind ?? undefined,
      rich_buttons: q.buttons ?? undefined,
      button_text: q.button_text ?? undefined,
      button_url: q.button_url ?? undefined,
    });
  }

  async function onSendFile(file: File, caption: string) {
    const qs = contact.business_phone_number_id
      ? `?phone_number_id=${encodeURIComponent(contact.business_phone_number_id)}`
      : "";
    const fd = new FormData();
    fd.append("file", file);
    const up = await fetch(`/api/upload-media${qs}`, { method: "POST", body: fd });
    const upJson = (await up.json()) as { media_id?: string; media_url?: string; kind?: string; mime?: string; error?: string };
    if (!up.ok) throw new Error(upJson.error ?? "Upload failed");
    await post({
      kind: "media",
      media_id: upJson.media_id,
      media_url: upJson.media_url,
      media_kind: upJson.kind,
      media_mime: upJson.mime,
      caption: caption || undefined,
    });
  }

  async function onSendVoice(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const up = await fetch("/api/voice-note", { method: "POST", body: fd });
    const upJson = (await up.json()) as { media_url?: string; mime?: string; error?: string };
    if (!up.ok) throw new Error(upJson.error ?? "Upload failed");
    await post({ kind: "media", media_url: upJson.media_url, media_kind: "audio", media_mime: upJson.mime ?? "audio/ogg" });
  }

  async function onSendTemplate(t: TemplateSummary) {
    const bodyVars = (t.body.match(/\{\{(\d+)\}\}/g) ?? []).length;
    const needsMedia = t.header_format === "IMAGE" || t.header_format === "VIDEO" || t.header_format === "DOCUMENT";
    if (bodyVars > 0 || needsMedia) {
      // Variable / media templates need the fill dialog — open the full chat.
      router.push(`/dashboard?c=${contact.id}`);
      return;
    }
    await post({
      kind: "template",
      template_name: t.name,
      template_language: t.language,
      template_body_preview: t.body,
      template_footer: t.footer ?? null,
      template_buttons: t.buttons ?? null,
    });
  }

  return (
    <MessageInput
      mode={mode}
      onModeChange={setMode}
      onSend={onSend}
      onSaveNote={onSaveNote}
      onSendRich={onSendRich}
      onSendTemplate={onSendTemplate}
      onSendFile={onSendFile}
      onSendVoice={onSendVoice}
      phoneNumberId={contact.business_phone_number_id}
      contactId={contact.id}
      windowOpen={contact.window_open !== false}
      compact
    />
  );
}
