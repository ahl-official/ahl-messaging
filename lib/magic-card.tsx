// Inbuilt magic-message card renderer — replaces the external Puppeteer
// service at services/image-generator. We render the same 880×880 card via
// `next/og` so a missing/dead localhost:3001 can never break Magic Message
// sends. No new deps; ImageResponse ships with Next.js.

import { ImageResponse } from "next/og";
import { promises as fs } from "node:fs";
import path from "node:path";

let cachedLogoDataUrl: string | null | undefined;

async function getLogoDataUrl(): Promise<string | null> {
  if (cachedLogoDataUrl !== undefined) return cachedLogoDataUrl;
  try {
    const buf = await fs.readFile(path.join(process.cwd(), "public", "logo.png"));
    cachedLogoDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    cachedLogoDataUrl = null;
  }
  return cachedLogoDataUrl;
}

const CARD_W = 880;
const TEXT_W = 700; //   880 − 40·2 (green pad) − 50·2 (white pad)
const LINE_H = 1.4;
const MIN_H = 880; //    short messages keep the square look
const MAX_H = 2200; //   hard ceiling (WhatsApp won't show an absurdly tall img)
// Fixed vertical chrome: green pad (80) + white pad (80) + body paddingBottom
// (20) + footer border/pad/content (~60) + a safety margin (40).
const CHROME_H = 280;

function pickFontSize(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words <= 30) return 46;
  if (words <= 60) return 40;
  if (words <= 100) return 36;
  if (words <= 150) return 32;
  if (words <= 200) return 28;
  return 26;
}

// Estimate the rendered text height so the card can grow to fit instead of
// clipping. next/og doesn't auto-size, so we approximate the wrapped line
// count (honouring explicit newlines) and bias slightly tall (+1 line, wide
// char factor) so a near-full line never gets cut off.
function estimateTextHeight(text: string, fontSize: number): number {
  const charsPerLine = Math.max(1, Math.floor(TEXT_W / (fontSize * 0.55)));
  let lines = 1;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    lines += raw.length === 0 ? 1 : Math.ceil(raw.length / charsPerLine);
  }
  return lines * fontSize * LINE_H;
}

export async function renderMagicCardPng(opts: {
  text: string;
  agentName: string;
}): Promise<{ bytes: ArrayBuffer; mime: "image/png" }> {
  const text = opts.text || "";
  const agentName = opts.agentName?.trim() || "Support Agent";
  const fontSize = pickFontSize(text);
  // Grow the card to fit the text (clamped) so long messages aren't clipped.
  const height = Math.min(
    MAX_H,
    Math.max(MIN_H, Math.ceil(CHROME_H + estimateTextHeight(text, fontSize))),
  );
  const logoSrc = await getLogoDataUrl();

  const response = new ImageResponse(
    (
      <div
        style={{
          width: `${CARD_W}px`,
          height: `${height}px`,
          backgroundColor: "#0de531",
          padding: 40,
          display: "flex",
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            backgroundColor: "#ffffff",
            width: "100%",
            borderRadius: 24,
            display: "flex",
            flexDirection: "column",
            padding: "40px 50px",
          }}
        >
          <div
            style={{
              flex: 1,
              // minHeight:0 lets this flex child actually shrink, and
              // overflow:hidden clips an over-long message at the body boundary
              // so it can never bleed onto the footer below.
              minHeight: 0,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              paddingBottom: 20,
            }}
          >
            <div
              style={{
                fontSize,
                color: "#1a1a2e",
                fontWeight: 500,
                lineHeight: 1.4,
                width: "100%",
                whiteSpace: "pre-wrap",
                display: "flex",
              }}
            >
              {text}
            </div>
          </div>
          <div
            style={{
              flexShrink: 0,
              borderTop: "1px solid #eaeaea",
              paddingTop: 20,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                color: "#888",
                fontSize: 15,
              }}
            >
              <span>Replied By</span>
              <span
                style={{
                  marginLeft: 8,
                  color: "#1a1a2e",
                  fontWeight: 600,
                  fontSize: 20,
                }}
              >
                {agentName}
              </span>
            </div>
            {logoSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoSrc}
                alt="American Hairline"
                style={{ height: 36, width: "auto", maxWidth: 140 }}
              />
            ) : null}
          </div>
        </div>
      </div>
    ),
    { width: CARD_W, height },
  );

  const bytes = await response.arrayBuffer();
  return { bytes, mime: "image/png" };
}
