// WAHA outbound API adapter
// Maps Evolution-style calls to WAHA REST API

const getWahaBase = () =>
  (process.env.WAHA_SERVER_URL || "").replace(/\/$/, "");

const getWahaKey = () => process.env.WAHA_API_KEY || "";

function wahaHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Api-Key": getWahaKey(),
  };
}

// Normalise phone number to WAHA chatId format
// Input: "919876543210" or "919876543210@s.whatsapp.net" or "919876543210@c.us"
// Output: "919876543210@c.us"
export function toWahaChatId(number: string): string {
  const clean = number.replace(/@.*$/, "").replace(/\D/g, "");
  return `${clean}@c.us`;
}

// Send text message
export async function wahaSendText(
  session: string,
  number: string,
  text: string,
  replyToId?: string
): Promise<{ id?: string } | null> {
  try {
    const res = await fetch(`${getWahaBase()}/api/sendText`, {
      method: "POST",
      headers: wahaHeaders(),
      body: JSON.stringify({
        session,
        chatId: toWahaChatId(number),
        text,
        reply_to: replyToId || null,
        linkPreview: true,
      }),
    });
    if (!res.ok) {
      console.error("[WAHA] sendText failed:", res.status, await res.text());
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("[WAHA] sendText error:", err);
    return null;
  }
}

// Send image
export async function wahaSendImage(
  session: string,
  number: string,
  imageUrl: string,
  caption?: string
): Promise<{ id?: string } | null> {
  try {
    const res = await fetch(`${getWahaBase()}/api/sendImage`, {
      method: "POST",
      headers: wahaHeaders(),
      body: JSON.stringify({
        session,
        chatId: toWahaChatId(number),
        file: { url: imageUrl },
        caption: caption || "",
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("[WAHA] sendImage error:", err);
    return null;
  }
}

// Send file/document
export async function wahaSendFile(
  session: string,
  number: string,
  fileUrl: string,
  caption?: string
): Promise<{ id?: string } | null> {
  try {
    const res = await fetch(`${getWahaBase()}/api/sendFile`, {
      method: "POST",
      headers: wahaHeaders(),
      body: JSON.stringify({
        session,
        chatId: toWahaChatId(number),
        file: { url: fileUrl },
        caption: caption || "",
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("[WAHA] sendFile error:", err);
    return null;
  }
}

// Send voice note
export async function wahaSendVoice(
  session: string,
  number: string,
  audioUrl: string
): Promise<{ id?: string } | null> {
  try {
    const res = await fetch(`${getWahaBase()}/api/sendVoice`, {
      method: "POST",
      headers: wahaHeaders(),
      body: JSON.stringify({
        session,
        chatId: toWahaChatId(number),
        file: { url: audioUrl },
      }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("[WAHA] sendVoice error:", err);
    return null;
  }
}

// Get session status
export async function wahaGetSession(session: string): Promise<{
  status: string;
  me?: { id: string; pushName?: string };
} | null> {
  try {
    const res = await fetch(`${getWahaBase()}/api/sessions/${session}`, {
      headers: wahaHeaders(),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("[WAHA] getSession error:", err);
    return null;
  }
}

// Get QR code for session
export async function wahaGetQR(session: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${getWahaBase()}/api/${session}/auth/qr?format=raw`,
      { headers: wahaHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.value || null;
  } catch (err) {
    console.error("[WAHA] getQR error:", err);
    return null;
  }
}

// Set webhook on a session
export async function wahaSetWebhook(
  session: string,
  webhookUrl: string
): Promise<boolean> {
  try {
    const res = await fetch(`${getWahaBase()}/api/sessions/${session}`, {
      method: "PUT",
      headers: wahaHeaders(),
      body: JSON.stringify({
        config: {
          webhooks: [
            {
              url: webhookUrl,
              events: [
                "message",
                "message.any",
                "message.ack",
                "message.revoked",
                "session.status",
              ],
              hmac: null,
              retries: null,
              customHeaders: null,
            },
          ],
        },
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("[WAHA] setWebhook error:", err);
    return false;
  }
}

// Mark messages as read
export async function wahaMarkRead(
  session: string,
  chatId: string
): Promise<boolean> {
  try {
    const res = await fetch(
      `${getWahaBase()}/api/${session}/chats/${chatId}/messages/read`,
      {
        method: "POST",
        headers: wahaHeaders(),
        body: JSON.stringify({}),
      }
    );
    return res.ok;
  } catch (err) {
    console.error("[WAHA] markRead error:", err);
    return false;
  }
}

// Health check
export async function wahaHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${getWahaBase()}/health`, {
      headers: wahaHeaders(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
