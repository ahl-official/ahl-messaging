const express = require('express');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

// ─── Rate Limiting: 30 requests per minute per IP ─────────────────────────
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again after a minute.' }
});
app.use('/generate-image', limiter);

// ─── Concurrent Browser Limiter ───────────────────────────────────────────
const MAX_CONCURRENT_BROWSERS = 3;
let activeBrowsers = 0;

// ─── HTML Escape (XSS Prevention) ─────────────────────────────────────────
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ─── Pre-load Logo at Startup (cached in memory) ──────────────────────────
let logoDataUrl = "";
try {
    const logoPath = path.join(__dirname, 'logo.png');
    const logoBase64 = fs.readFileSync(logoPath, 'base64');
    logoDataUrl = `data:image/png;base64,${logoBase64}`;
    console.log('Logo loaded successfully.');
} catch (err) {
    console.warn('Warning: logo.png not found. Images will be generated without logo.');
}

// ─── Main Route ───────────────────────────────────────────────────────────
app.post('/generate-image', async (req, res) => {

    // Concurrency check
    if (activeBrowsers >= MAX_CONCURRENT_BROWSERS) {
        return res.status(429).json({ error: 'Server is busy. Please try again shortly.' });
    }

    // Input validation
    const rawText = req.body.text;
    const rawAgentName = req.body.agentName;
    const targetUrl = req.body.url;

    if (rawText !== undefined && typeof rawText !== 'string') {
        return res.status(400).json({ error: 'Invalid input: text must be a string.' });
    }
    if (rawAgentName !== undefined && typeof rawAgentName !== 'string') {
        return res.status(400).json({ error: 'Invalid input: agentName must be a string.' });
    }
    if (rawText && rawText.length > 2000) {
        return res.status(400).json({ error: 'Text too long. Maximum 2000 characters allowed.' });
    }
    if (rawAgentName && rawAgentName.length > 100) {
        return res.status(400).json({ error: 'Agent name too long. Maximum 100 characters allowed.' });
    }

    // Sanitize inputs (XSS fix)
    const dynamicText = escapeHtml(rawText || "");
    const agentName = escapeHtml(rawAgentName || "Support Agent");

    // ── QR Code Generation ────────────────────────────────────────────────
    let qrCodeHtml = "";

    if (targetUrl && typeof targetUrl === 'string' && targetUrl.trim() !== "") {
        try {
            const parsedUrl = new URL(targetUrl.trim());
            if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
                const mainQrDataUrl = await QRCode.toDataURL(targetUrl.trim(), {
                    width: 400,
                    margin: 1,
                    color: { dark: '#1a1a2e', light: '#ffffff' }
                });
                qrCodeHtml = `
                    <div class="qr-container">
                        <img class="main-qr-image" src="${mainQrDataUrl}" alt="Main QR Code" />
                        <div class="scan-text">scan link</div>
                    </div>
                `;
            }
        } catch (err) {
            console.log(`Ignored invalid URL input: "${targetUrl}"`);
        }
    }

    // ── Font size based on word count ─────────────────────────────────────
    const wordCount = (rawText || "").trim().split(/\s+/).filter(Boolean).length;
    let fontSize;
    if      (wordCount <= 30)  fontSize = 52;
    else if (wordCount <= 60)  fontSize = 46;
    else if (wordCount <= 100) fontSize = 40;
    else if (wordCount <= 150) fontSize = 36;
    else if (wordCount <= 200) fontSize = 32;
    else                       fontSize = 28;

    // ── HTML Template ─────────────────────────────────────────────────────
    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }

            body {
                margin: 0;
                padding: 0;
                background: transparent;
                /* System font fallback if Google Fonts fails */
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: inline-block;
            }

            /* Capture area: fixed width, height grows with content */
            #capture-area {
                width: 880px;
                min-height: 880px;
                height: auto;
                background-color: #0de531;
                padding: 40px;
                display: flex;
                align-items: stretch;
            }

            .card {
                background-color: #ffffff;
                width: 100%;
                border-radius: 24px;
                display: flex;
                flex-direction: column;
                padding: 40px 50px;
            }

            /* Main content grows with text, pushes footer to bottom */
            .main-content {
                flex: 1;
                display: flex;
                flex-direction: column;
                justify-content: center;
                padding-bottom: 20px;
            }

            /* QR Code */
            .qr-container {
                margin-bottom: 30px;
                display: flex;
                flex-direction: column;
                align-items: center;
                align-self: center;
                flex-shrink: 0;
            }
            .main-qr-image {
                width: 260px;
                height: 260px;
                border-radius: 12px;
                border: 2px solid #eaeaea;
            }
            .scan-text {
                margin-top: 10px;
                font-size: 14px;
                color: #1a1a2e;
                opacity: 0.4;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 2px;
            }

            /* Text wrapper — expands naturally */
            .text-wrapper {
                display: flex;
                align-items: flex-start;
            }

            .text-wrapper h1 {
                font-size: ${fontSize}px;
                color: #1a1a2e;
                font-weight: 500;
                line-height: 1.6;
                word-wrap: break-word;
                word-break: break-word;
                text-align: left;
                white-space: pre-wrap;
                width: 100%;
            }

            /* Footer */
            .footer {
                border-top: 1px solid #eaeaea;
                padding-top: 20px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                flex-shrink: 0;
            }
            .replied-by {
                display: flex;
                align-items: center;
                color: #888;
                font-size: 15px;
            }
            .replied-by span {
                margin-left: 8px;
                color: #1a1a2e;
                font-weight: 600;
                font-size: 20px;
            }
            .footer-right {
                display: flex;
                flex-direction: row;
                align-items: center;
                gap: 12px;
            }
            .powered-by {
                color: #999;
                font-size: 13px;
                font-weight: 500;
            }
            .footer-logo {
                height: 36px;
                width: auto;
                max-width: 140px;
                object-fit: contain;
            }
        </style>
    </head>
    <body>
        <div id="capture-area">
            <div class="card">
                <div class="main-content">
                    ${qrCodeHtml}
                    <div class="text-wrapper">
                        <h1>${dynamicText}</h1>
                    </div>
                </div>
                <div class="footer">
                    <div class="replied-by">Replied By <span>${agentName}</span></div>
                    <div class="footer-right">
                        <div class="powered-by">powered by americanhairline.com</div>
                        ${logoDataUrl ? `<img class="footer-logo" src="${logoDataUrl}" alt="QHT Logo" />` : ''}
                    </div>
                </div>
            </div>
        </div>

        <script>
            // Signal Puppeteer — no adjustment needed (font set server-side)
            window.__fontAdjusted = true;
        </script>
    </body>
    </html>
    `;

    // ── Puppeteer Screenshot ──────────────────────────────────────────────
    // Strategy: render the card with NO external network dependencies. We
    // disable JS in the page (we don't need any), and we abort every request
    // except the initial document — even if a stray <img>/<link> sneaks in
    // it can't stall setContent. Combined with a generous timeout and a
    // single retry, this makes the renderer reliable in offline / slow-net
    // / blocked-CDN environments.
    let browser = null;
    activeBrowsers++;

    async function renderOnce() {
        const b = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
            protocolTimeout: 60_000,
        });
        try {
            const page = await b.newPage();
            page.setDefaultNavigationTimeout(45_000);
            page.setDefaultTimeout(45_000);
            await page.setJavaScriptEnabled(false);

            // Block every subresource — fonts, images, stylesheets, scripts.
            // The card uses inline <style> + a base64 logo data URI, so it
            // doesn't need anything off the network.
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (req.resourceType() === 'document') return req.continue();
                req.abort();
            });

            await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });

            const element = await page.$('#capture-area');
            const imageBuffer = await element.screenshot({ type: 'png', omitBackground: true });
            return imageBuffer;
        } finally {
            await b.close();
        }
    }

    try {
        let imageBuffer;
        try {
            imageBuffer = await renderOnce();
        } catch (firstError) {
            console.warn(`Puppeteer first attempt failed: ${firstError.message}. Retrying...`);
            imageBuffer = await renderOnce();
        }

        res.set('Content-Type', 'image/png');
        res.set('Content-Disposition', 'attachment; filename="dynamic-greeting.png"');
        res.send(imageBuffer);

    } catch (error) {
        console.error("Error generating image:", error);
        res.status(500).json({ error: 'Failed to generate image. Please try again.' });
    } finally {
        // Always close browser — even if screenshot fails (memory leak fix)
        if (browser) {
            await browser.close();
        }
        activeBrowsers--;
    }
});

// ─── Health Check ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', activeBrowsers, maxConcurrent: MAX_CONCURRENT_BROWSERS });
});

// ─── Start Server ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Image generator running on port ${PORT}`);
});
