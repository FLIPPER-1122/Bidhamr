import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Supabase-projektet (prod eller test) kommer fra miljoet, saa CSP'en altid
// matcher den database, buildet bruger. Bruges til API, realtime (wss) og
// billeder fra storage.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseWss = supabaseUrl.replace(/^https:/, "wss:");

// Uden nonces (se node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md):
// Next.js indsaetter inline-scripts, saa 'unsafe-inline' er noedvendig her.
// Stripe-domaener efter Stripes egen CSP-vejledning (Payment Element, 3DS, MobilePay).
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://js.stripe.com`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' blob: data: ${supabaseUrl} https://*.stripe.com`,
  "font-src 'self'",
  `connect-src 'self' ${supabaseUrl} ${supabaseWss} https://api.stripe.com https://*.stripe.com https://api.dataforsyningen.dk`,
  "frame-src https://js.stripe.com https://hooks.stripe.com https://m.stripe.network",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const sikkerhedsHeadere = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // payment er tilladt for egen side og Stripe (Apple Pay/Google Pay i Payment Element).
  {
    key: "Permissions-Policy",
    value:
      'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(self "https://js.stripe.com")',
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: sikkerhedsHeadere }];
  },
};

export default nextConfig;
