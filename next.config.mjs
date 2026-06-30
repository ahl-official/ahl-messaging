// Baseline security response headers applied to every route. (A strict
// Content-Security-Policy is intentionally left out for now — it needs
// per-route testing against Next's inline runtime scripts; tracked in
// SECURITY_AUDIT.md as a follow-up.)
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=()",
  },
];

// /embed routes are framed by the CRM, so they must NOT carry X-Frame-Options:
// DENY. Their frame-ancestors CSP is set at RUNTIME in middleware.ts from the
// owner-managed origin list (Settings → Embed) — that's why it's absent here
// (a static CSP here would intersect with the runtime one and block any
// dynamically-added domain). Everything except the CSP/XFO is kept.
const embedHeaders = securityHeaders.filter(
  (h) => h.key !== "X-Frame-Options",
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework/version in responses.
  poweredByHeader: false,
  // A cosmetic ESLint *error* (unescaped quote, raw <img>, missing dep) must
  // NEVER fail `next build` — a failed build leaves a half-written .next, and
  // serving that produces unstyled pages + client-side "Application error"
  // crashes in production. TypeScript still type-checks and blocks real type
  // errors below; lint is for dev, run it separately, don't let it down the site.
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      // Everything except /embed and /embed/* keeps the X-Frame-Options:
      // DENY baseline. Full-segment match — a future /embed-foo or
      // /embedded-x route still gets the DENY headers.
      { source: "/((?!embed(?:/|$)).*)", headers: securityHeaders },
      // /embed/* is frameable by the CRM only (frame-ancestors above).
      { source: "/embed/:path*", headers: embedHeaders },
    ];
  },
  // Required by Next.js 14.2 to load the root-level instrumentation.ts
  // hook — that's what arms the periodic sweep that resumes the AI bot
  // after a takeover pause expires. Stable in 15+, but we're on 14.2.
  experimental: {
    instrumentationHook: true,
    // Rewrite barrel imports to per-export deep imports so each route only
    // ships the icons/animations it actually uses (lucide-react is 38MB
    // installed; motion is barrel-imported across many components). No
    // code changes — just smaller per-route chunks + faster compiles.
    optimizePackageImports: ["lucide-react", "motion/react"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
};

export default nextConfig;
