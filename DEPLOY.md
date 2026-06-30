# Deploy runbook — keep the site up, never white-screen

Goal: every deploy produces a **working, styled** site. No "Application error",
no unstyled page, no offline.

## Why the site breaks (root causes)

The "Application error: a client-side exception" page and the **unstyled** login
page are almost ALWAYS the same root cause: the browser loaded HTML that points
at JS/CSS chunk files that **don't exist on the server** (404). When chunks 404:

- CSS 404 → page renders with **no styling** (raw HTML).
- JS chunk 404 / throws → **client-side exception** (white screen).

How the chunks end up mismatched:

1. **`pm2 restart` without a fresh `npm run build`** — new source, old `.next`
   (or the reverse). The running server serves HTML for chunks that aren't built.
2. **`npm run build` failed or was interrupted** — `.next` is left half-written,
   so some chunks are missing. Restarting onto a broken build = broken site.
3. **Stale browser tab after a deploy** — an old tab references the previous
   build's chunk hashes; the new build deleted them. (The new error boundary
   now auto-reloads this case, but a clean deploy avoids it.)
4. **A required env var missing/typo'd in `.env.local`** — e.g.
   `NEXT_PUBLIC_SUPABASE_URL`. The app throws on load. Build-time env
   (`CRM_EMBED_ORIGIN`, `NEXT_PUBLIC_*`) is baked at **build** time, so it must
   be set BEFORE `npm run build`, and you must rebuild after changing it.
5. **`next build` failing on an ESLint error** — e.g. an unescaped `"` in JSX
   (`react/no-unescaped-entities`) or a raw `<img>`. By default Next FAILS the
   build on lint errors → half-written `.next` → unstyled / white-screen. This
   is now disabled: `eslint.ignoreDuringBuilds: true` in `next.config.mjs`, so
   a cosmetic lint error can never take the site down. (Type errors still block
   — those are real.) **This was the cause of the 13 Jun outage.**

## The ONLY deploy command to use (clean, safe)

```bash
cd /opt/QHT-Messaging
git fetch origin
git reset --hard origin/main   # match main EXACTLY — drops stray local edits…
git clean -fd                  # …and stray untracked files that break the build
                               #   (.env.local is gitignored, so it is NOT touched)
npm install
rm -rf .next                   # drop any stale/partial build — the key step
npm run build                  # MUST print "Compiled successfully" / route table
# ^ If build FAILS, STOP. Do NOT restart pm2 — read the error, fix, rebuild.
pm2 restart qht-messaging --update-env
pm2 save
```

Why `reset --hard` + `clean -fd`: a deploy that just `git pull`s can leave the
VPS with half-merged or stray uncommitted files (someone edited on the server),
and a single stray `.ts` with a type error fails `next build` → the `&& pm2
restart` never runs → the OLD code keeps serving, so your latest fix "doesn't
work" even though it's pushed. Resetting to `origin/main` guarantees the build
is EXACTLY what's on GitHub. (The VPS is a deploy target, not a dev machine —
never edit code directly on it; commit + push, then deploy.)

## Confirm the NEW code is actually live

After deploy, hard-refresh and check the behaviour that changed. E.g. for the
"send images in parallel" fix: pick 4 images → Send → the tiles vanish instantly,
the Send button does NOT sit on "Sending…", and you can keep typing/sending. If
you still see "Sending…" stuck, you're on OLD code → the build failed or pm2
didn't restart. Re-run the block above and watch for "Compiled successfully".

Rules:

- **Never** `pm2 restart` unless the build above finished **successfully**.
- Always `rm -rf .next` before `npm run build` — this alone prevents the stale
  chunk mismatch that causes the unstyled / white-screen errors.
- After changing `.env.local`, you MUST `npm run build` again (env is baked in),
  not just restart.

## Verify after deploy (10 seconds)

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://wa.hairmedindia.com/login   # want: 200
pm2 status qht-messaging                                                       # want: online
```

Then in the browser do a **hard refresh** (Cmd/Ctrl + Shift + R) to drop any
cached old chunks.

## If the site is already broken (recovery)

```bash
cd /opt/QHT-Messaging
pm2 logs qht-messaging --lines 40 --nostream   # look for the real error
rm -rf .next && npm run build && pm2 restart qht-messaging --update-env
```

- Unstyled / white screen but build succeeds → it was a stale `.next`; the clean
  rebuild above fixes it. Hard-refresh the browser.
- Build fails → the error names the file + reason. Fix that, rebuild. Don't
  restart onto a failed build.
- Still down → `pm2 logs` shows a runtime error (often a missing env var). Check
  `.env.local` has every `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`,
  and `PORTFOLIO_KEYS` entry, then rebuild.

## Safety nets already in the code

- `app/global-error.tsx` + `app/error.tsx`: a crash no longer shows a blank
  "Application error". A stale-deploy chunk error **auto-reloads once** (pulls
  the fresh build); any other crash shows a calm "Reload" card.
- These don't replace a clean deploy — they just stop a transient error from
  looking like the whole app is down.
