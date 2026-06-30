// PayU UPI deeplink scraper.
//
// PayU's public docs don't expose the `upi://pay?…` deeplink that
// powers the /upfrontQr screen on their hosted checkout. The DBQR
// server-to-server API (which would return it cleanly) is gated behind
// a per-MID activation that our account doesn't have right now (EX158
// "Merchant Integration Exception").
//
// Workaround: open the payment-link short URL in headless Chromium and
// step the patient view through PayU's 3-stage flow:
//   stage 1  payu.in/invoice/{id}                  → click "MAKE PAYMENT"
//   stage 2  api.payu.in/public/#/{id}/paymentoptions → click "UPI"
//   stage 3  api.payu.in/public/#/{id}/upfrontQr   → extract QR
//
// Extraction tries four strategies in order of preference:
//   1. network capture — any JSON response with an `upi://…` string
//   2. DOM attribute scan
//   3. embedded JSON (Next data / window state)
//   4. canvas screenshot — last-resort PNG of PayU's rendered QR
//
// On failure the page screenshot + HTML are dumped to /tmp/payu-debug-*
// so we can diagnose what PayU actually served.

import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";

let cachedBrowser: Browser | null = null;
let browserStarting: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser && cachedBrowser.isConnected()) return cachedBrowser;
  if (browserStarting) return browserStarting;
  browserStarting = chromium
    .launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    })
    .then((b) => {
      cachedBrowser = b;
      browserStarting = null;
      b.on("disconnected", () => {
        cachedBrowser = null;
      });
      return b;
    })
    .catch((e) => {
      browserStarting = null;
      throw e;
    });
  return browserStarting;
}

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

function looksLikeUpiIntent(s: unknown): s is string {
  return typeof s === "string" && s.startsWith("upi://");
}

function findUpiInJson(j: unknown): string | null {
  if (j == null) return null;
  if (looksLikeUpiIntent(j)) return j;
  if (Array.isArray(j)) {
    for (const item of j) {
      const r = findUpiInJson(item);
      if (r) return r;
    }
    return null;
  }
  if (typeof j === "object") {
    for (const v of Object.values(j as Record<string, unknown>)) {
      const r = findUpiInJson(v);
      if (r) return r;
    }
  }
  return null;
}

export interface PayuQrResult {
  /** Preferred — re-encode this with the qrcode lib for crisp output. */
  deeplink: string | null;
  /** Fallback — PNG bytes of PayU's rendered QR canvas, sized as-is. */
  canvasPng: Buffer | null;
  /** The page URL we settled on; logged for diagnostics. */
  finalUrl: string;
  /** Which extraction strategy succeeded. */
  source: "network" | "dom" | "next-data" | "canvas" | "none";
}

async function clickFirstVisible(
  page: import("playwright").Page,
  selectors: string[],
  label: string,
): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.click({ timeout: 3000 }).catch(() => {});
        console.log(`[payu-scrape] ${label} clicked via ${sel}`);
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

/** Open a PayU payment-link short URL in a headless mobile browser,
 *  step through PayU's hosted checkout to the UPI QR screen, and
 *  return the QR as either a `upi://…` deeplink (preferred) or a PNG
 *  screenshot of PayU's rendered canvas (fallback). */
export async function fetchPayuUpiQr(shortUrl: string): Promise<PayuQrResult> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: MOBILE_UA,
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  let deeplink: string | null = null;
  let source: PayuQrResult["source"] = "none";

  page.on("response", async (res) => {
    if (deeplink) return;
    const ct = (res.headers()["content-type"] || "").toLowerCase();
    if (!ct.includes("json")) return;
    try {
      const j = await res.json();
      const hit = findUpiInJson(j);
      if (hit) {
        deeplink = hit;
        source = "network";
        console.log(`[payu-scrape] deeplink via network @ ${res.url()}`);
      }
    } catch {
      /* body unreadable / already consumed */
    }
  });

  let finalUrl = "";
  let canvasPng: Buffer | null = null;

  try {
    console.log(`[payu-scrape] opening ${shortUrl}`);
    await page.goto(shortUrl, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
    await page
      .waitForFunction(
        () => /payu\.in\/invoice|api\.payu\.in\/public/.test(location.href),
        { timeout: 15_000 },
      )
      .catch(() => {});
    console.log(`[payu-scrape] stage 1 url=${page.url()}`);

    // Stage 1 — Pre-payment page. Phone + email come pre-populated
    // from the payment-link create call. Submit control is an
    // `<input type="submit" value="Make Payment">`. PayU's React
    // hydration controls the form state, so we wait for the input to
    // be attached, then click it as a real user gesture.
    if (page.url().includes("payu.in/invoice")) {
      // Give React up to 8s to mount + hydrate the form.
      try {
        await page.waitForSelector('input[type="submit"]', {
          state: "visible",
          timeout: 8_000,
        });
      } catch {
        console.log("[payu-scrape] submit input never became visible");
      }

      // Force click — bypasses Playwright's actionability checks that
      // sometimes reject inputs inside mobile-styled forms.
      let stage1Clicked = false;
      try {
        await page.click('input[type="submit"]', {
          force: true,
          timeout: 4_000,
        });
        console.log("[payu-scrape] MAKE PAYMENT clicked via input[type=submit]");
        stage1Clicked = true;
      } catch (e) {
        console.log(
          `[payu-scrape] direct click failed: ${e instanceof Error ? e.message : e}`,
        );
      }

      // If the click didn't navigate, fall back to dispatching a
      // synthetic mousedown→mouseup→click sequence on the input.
      await page
        .waitForURL(/api\.payu\.in\/public/, { timeout: 10_000 })
        .catch(() => {});

      if (page.url().includes("payu.in/invoice")) {
        console.log(
          "[payu-scrape] still on /invoice after click — synthesising mouse events",
        );
        await page
          .evaluate(() => {
            const el = document.querySelector(
              'input[type="submit"]',
            ) as HTMLInputElement | null;
            if (!el) return;
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent("mousedown", opts));
            el.dispatchEvent(new MouseEvent("mouseup", opts));
            el.dispatchEvent(new MouseEvent("click", opts));
          })
          .catch(() => {});
        await page
          .waitForURL(/api\.payu\.in\/public/, { timeout: 10_000 })
          .catch(() => {});
      }

      // Last-ditch — form.requestSubmit() in case PayU listens on the
      // submit event rather than the click.
      if (page.url().includes("payu.in/invoice")) {
        console.log(
          "[payu-scrape] still on /invoice after synth click — form.requestSubmit()",
        );
        await page
          .evaluate(() => {
            const f = document.querySelector(
              "form.payment-form",
            ) as HTMLFormElement | null;
            if (f) {
              if (typeof f.requestSubmit === "function") f.requestSubmit();
              else f.submit();
            }
          })
          .catch(() => {});
        await page
          .waitForURL(/api\.payu\.in\/public/, { timeout: 10_000 })
          .catch(() => {});
      }
      void stage1Clicked;
      console.log(`[payu-scrape] stage 2 url=${page.url()}`);
    }

    // Stage 2 — Payment-method picker. PayU's React app lands on a
    // /backPress hash after MAKE PAYMENT but renders the payment-method
    // tiles. We wait for the "UPI" text to appear, then click it. NO
    // hash-route forcing here — that confuses the React router into
    // rendering an empty /upfrontQr without the selection state.
    if (page.url().includes("api.payu.in") && !deeplink) {
      try {
        await page.waitForSelector('text="UPI"', {
          state: "visible",
          timeout: 10_000,
        });
      } catch {
        console.log("[payu-scrape] UPI text never appeared on options page");
      }

      let clicked = false;
      try {
        await page
          .locator('text="UPI"')
          .first()
          .click({ force: true, timeout: 4_000 });
        console.log("[payu-scrape] UPI clicked via text=UPI");
        clicked = true;
      } catch (e) {
        console.log(
          `[payu-scrape] text=UPI click failed: ${e instanceof Error ? e.message : e}`,
        );
      }

      if (!clicked) {
        // Walk up to the nearest clickable ancestor of the UPI text
        // and dispatch a click there — handles the case where the
        // text node itself isn't actionable.
        await page
          .evaluate(() => {
            const all = Array.from(document.querySelectorAll("*"));
            const target = all.find((el) => {
              const txt = (el.textContent || "").trim();
              return /^UPI$/i.test(txt);
            });
            if (!target) return;
            let cur: Element | null = target;
            while (cur && cur !== document.body) {
              const cs = window.getComputedStyle(cur);
              if (
                cs.cursor === "pointer" ||
                cur.getAttribute("role") === "button" ||
                cur.tagName === "BUTTON" ||
                cur.tagName === "A"
              ) {
                (cur as HTMLElement).click();
                return;
              }
              cur = cur.parentElement;
            }
            (target as HTMLElement).click();
          })
          .catch(() => {});
        console.log("[payu-scrape] UPI synth click via ancestor walk");
      }

      await page
        .waitForURL(/upfrontQr|\/upi/, { timeout: 12_000 })
        .catch(() => {});
      console.log(`[payu-scrape] stage 3 url=${page.url()}`);

      // QHT MID often lands on /upi (app picker), not /upfrontQr.
      // Force the upfrontQr hash — UPI is already selected at this
      // point, so PayU's React app renders the QR view.
      if (
        page.url().includes("api.payu.in") &&
        !page.url().includes("upfrontQr")
      ) {
        await page
          .evaluate(() => {
            const m = location.hash.match(/^#\/([^/]+)/);
            if (m) location.hash = `#/${m[1]}/upfrontQr`;
          })
          .catch(() => {});
        await page.waitForTimeout(2_000);
        console.log(`[payu-scrape] stage 3b url=${page.url()}`);
      }
    }

    // Wait up to 18s for EITHER a deeplink to arrive on the network OR
    // a square QR-shaped element (canvas / svg / img) to render. The
    // QR on /upfrontQr can be any of those depending on the MID's
    // checkout build, so we look for ANY square ≥100px.
    const deadline = Date.now() + 18_000;
    let qrBounds: {
      x: number;
      y: number;
      width: number;
      height: number;
      tag: string;
    } | null = null;
    while (Date.now() < deadline) {
      if (deeplink) break;
      const found = await page
        .evaluate(() => {
          const els = Array.from(
            document.querySelectorAll("canvas, svg, img"),
          );
          let best: {
            x: number;
            y: number;
            width: number;
            height: number;
            tag: string;
          } | null = null;
          let bestArea = 0;
          for (const el of els) {
            const r = (el as Element).getBoundingClientRect();
            if (r.width < 100 || r.height < 100) continue;
            if (Math.abs(r.width - r.height) > 30) continue; // must be square
            const src = (el as HTMLImageElement).src || "";
            if (
              /logo|icon|payu|merchant|secureCheckout|bhim|upi-banner/i.test(
                src,
              )
            )
              continue;
            const area = r.width * r.height;
            if (area > bestArea) {
              bestArea = area;
              best = {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                tag: el.tagName,
              };
            }
          }
          return best;
        })
        .catch(() => null);
      if (found) {
        qrBounds = found;
        break;
      }
      await page.waitForTimeout(300);
    }
    if (qrBounds) {
      console.log(
        `[payu-scrape] QR element located: tag=${qrBounds.tag} ${Math.round(qrBounds.width)}x${Math.round(qrBounds.height)}`,
      );
    }

    // Strategy 2 + 3 — scan the DOM + embedded JSON for `upi://`.
    if (!deeplink) {
      const found = await page
        .evaluate(() => {
          const re = /upi:\/\/[^"'\s,}\]]+/;
          for (const el of Array.from(document.querySelectorAll("*"))) {
            for (const a of el.getAttributeNames()) {
              const v = el.getAttribute(a) || "";
              if (v.startsWith("upi://")) return { value: v, src: "dom-attr" };
            }
          }
          try {
            const next = document.getElementById("__NEXT_DATA__");
            if (next?.textContent) {
              const m = next.textContent.match(re);
              if (m) return { value: m[0], src: "next-data" };
            }
          } catch {
            /* ignore */
          }
          try {
            const w = window as unknown as Record<string, unknown>;
            for (const k of [
              "__INITIAL_STATE__",
              "__APP_STATE__",
              "__PAYU_STATE__",
              "__REDUX_STATE__",
            ]) {
              if (w[k]) {
                const m = JSON.stringify(w[k]).match(re);
                if (m) return { value: m[0], src: "window-state" };
              }
            }
          } catch {
            /* ignore */
          }
          return null;
        })
        .catch(() => null);
      if (found) {
        deeplink = found.value;
        source = found.src === "dom-attr" ? "dom" : "next-data";
        console.log(`[payu-scrape] deeplink via ${found.src}`);
      }
    }

    // Strategy 4 — clipped page screenshot of the QR element's bounds.
    // Works for canvas / svg / img alike because we just crop the
    // rectangle the QR sits in.
    if (!deeplink && qrBounds) {
      try {
        canvasPng = await page.screenshot({
          type: "png",
          clip: {
            x: qrBounds.x,
            y: qrBounds.y,
            width: qrBounds.width,
            height: qrBounds.height,
          },
        });
        source = "canvas";
        console.log(
          `[payu-scrape] QR clip captured (${canvasPng?.byteLength ?? 0} bytes, ${qrBounds.tag})`,
        );
      } catch (e) {
        console.log(
          `[payu-scrape] QR clip failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    } else if (!deeplink) {
      console.log("[payu-scrape] no QR element located within timeout");
    }
  } finally {
    finalUrl = finalUrl || page.url();
    // On failure, dump the rendered page so we can inspect what PayU
    // served. Best-effort — never block on it.
    if (!deeplink && !canvasPng) {
      try {
        const stamp = Date.now().toString(36);
        const base = `/tmp/payu-debug-${stamp}`;
        await fs.mkdir(path.dirname(base), { recursive: true }).catch(() => {});
        await page
          .screenshot({ path: `${base}.png`, fullPage: true })
          .then(() => console.log(`[payu-scrape] debug screenshot: ${base}.png`))
          .catch(() => {});
        const html = await page.content().catch(() => "");
        await fs
          .writeFile(`${base}.html`, html.slice(0, 200_000))
          .then(() => console.log(`[payu-scrape] debug html: ${base}.html`))
          .catch(() => {});
      } catch {
        /* swallow */
      }
    }
    await page.close().catch(() => {});
    await ctx.close().catch(() => {});
  }

  if (!deeplink && !canvasPng) {
    throw new Error(
      `PayU UPI QR scrape failed — finalUrl=${finalUrl}. Debug artefacts saved to /tmp/payu-debug-*.png + .html`,
    );
  }
  console.log(
    `[payu-scrape] done: source=${source} deeplink=${deeplink ? "yes" : "no"} canvas=${canvasPng ? "yes" : "no"}`,
  );
  return { deeplink, canvasPng, finalUrl, source };
}
