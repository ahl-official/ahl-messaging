# QHT Image Generator

Local Express + Puppeteer service that renders agent text onto a branded card.
Used by the **Magic Message → Text** flow in the dashboard to build the
dynamic header for the `magic_message` utility template.

This service is intentionally separate from the Next.js dashboard so it can
be edited and restarted independently.

## Layout

```
services/image-generator/
├── server.js        # Express app + Puppeteer renderer
├── package.json     # express, puppeteer, qrcode, express-rate-limit
├── logo.png         # QHT logo embedded into the card footer (NOT committed)
└── README.md        # this file
```

## First-time setup

1. **Drop in the logo** — copy `logo.png` (the QHT mark) into this folder.
   Without it, cards still render but without the footer logo.
2. **Install dependencies** (one-time, downloads Chromium ~200 MB):
   ```bash
   cd services/image-generator
   npm install
   ```

## Run

```bash
cd services/image-generator
npm start
```

Listens on **port 3001** by default. Override with `PORT=xxxx npm start`.

When running you should see:
```
Logo loaded successfully.
Image generator running on port 3001
```

## Smoke test

```bash
curl -X POST http://localhost:3001/generate-image \
  -H "Content-Type: application/json" \
  -d '{"text":"Hi Test, this is a magic message demo","agentName":"Test"}' \
  -o /tmp/out.png
file /tmp/out.png   # should say: PNG image data
open /tmp/out.png
```

## Wiring to the dashboard

The Next.js app reads the URL from `.env.local`:

```
MAGIC_MESSAGE_IMAGE_API_URL=http://localhost:3001/generate-image
```

After changing `.env.local`, **fully restart `npm run dev`** in the dashboard
root — Next.js only reads env vars at boot.

## Endpoints

- `POST /generate-image` — body `{ text, agentName, url? }`. Returns
  `image/png` bytes. Rate limited to 30 req/min/IP, max 3 concurrent.
- `GET /health` — `{ status, activeBrowsers, maxConcurrent }`.

## Editing the card

Card layout, fonts, colours, footer copy live inside `server.js` in the
`htmlContent` template literal. Save and restart the service to see changes.
