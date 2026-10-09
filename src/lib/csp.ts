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

export function lavCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseWss = supabaseUrl.replace(/^https:/, "wss:");

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com https://pay.google.com https://applepay.cdn-apple.com${isDev ? " 'unsafe-eval'" : ""}`,
    // React-style-attributter og Stripe kraever inline-styles.
    "style-src 'self' 'unsafe-inline'",
    // api.maptiler.com (og tile.openstreetmap.org uden nøgle): kortfliser i
    // "Vælg pakkeshop" (checkout).
    `img-src 'self' blob: data: ${supabaseUrl} https://*.stripe.com https://*.gstatic.com https://*.googleusercontent.com https://api.maptiler.com https://tile.openstreetmap.org`,
    "font-src 'self'",
    `connect-src 'self' ${supabaseUrl} ${supabaseWss} https://api.stripe.com https://*.stripe.com https://pay.google.com https://google.com/pay https://www.google.com/pay`,
    "frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://m.stripe.network https://pay.google.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
