// Content-Security-Policy med en ny nonce pr. forespoergsel. Bruges af
// src/proxy.ts. Next.js laeser noncen fra request-headeren og saetter den paa
// sine egne scripts (kraever dynamisk rendering - se src/app/layout.tsx).
//
// Stripe: script fra js.stripe.com (loades af et nonce'et script, saa
// 'strict-dynamic' tillader det), iframes til Payment Element, 3DS og
// MobilePay, og API-kald til api.stripe.com.
// Google Pay i Payment Element loader pay.google.com (script, iframe, kald).
// Apple Pay-knappen tegnes af Stripe i deres iframe, men Apple anbefaler
// applepay.cdn-apple.com til knap-scriptet, saa det er tilladt for en
// sikkerheds skyld.

export function lavNonce(): string {
  return btoa(crypto.randomUUID());
}

// Zone: "hoved" er hjemmesiden (bidhamr.dk). "admin" er admin-hosten
// (ADMIN_VAERT, src/lib/adminVaert.ts): ingen Stripe, Google Pay, Apple Pay
// eller kortfliser (MapTiler/OpenStreetMap) - kun egne filer og Supabase
// (billeder, log ud og upload af skærmbilleder til "Meld fejl"). data: i
// img-src er QR-koden ved opsætning af to-trins-login.
export type CspZone = "hoved" | "admin";

export function lavCsp(nonce: string, zone: CspZone = "hoved"): string {
  const isDev = process.env.NODE_ENV === "development";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseWss = supabaseUrl.replace(/^https:/, "wss:");
  const admin = zone === "admin";
  // Cloudflare Turnstile (CAPTCHA på login, glemt adgangskode og opret konto -
  // src/components/Turnstile.tsx): script og iframe fra challenges.cloudflare.com.
  // Kun på hjemmesiden og kun, når NEXT_PUBLIC_TURNSTILE_SITE_KEY er sat.
  const turnstile = !admin && (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "").trim() ? " https://challenges.cloudflare.com" : "";

  return [
    "default-src 'self'",
    admin
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com https://pay.google.com https://applepay.cdn-apple.com${turnstile}${isDev ? " 'unsafe-eval'" : ""}`,
    // React-style-attributter og Stripe kraever inline-styles.
    "style-src 'self' 'unsafe-inline'",
    // api.maptiler.com (og tile.openstreetmap.org uden nøgle): kortfliser i
    // "Vælg pakkeshop" (checkout).
    admin
      ? `img-src 'self' blob: data: ${supabaseUrl}`
      : `img-src 'self' blob: data: ${supabaseUrl} https://*.stripe.com https://*.gstatic.com https://*.googleusercontent.com https://api.maptiler.com https://tile.openstreetmap.org`,
    "font-src 'self'",
    admin
      ? `connect-src 'self' ${supabaseUrl} ${supabaseWss}`
      : `connect-src 'self' ${supabaseUrl} ${supabaseWss} https://api.stripe.com https://*.stripe.com https://pay.google.com https://google.com/pay https://www.google.com/pay${turnstile}`,
    admin
      ? "frame-src 'none'"
      : `frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://m.stripe.network https://pay.google.com${turnstile}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
