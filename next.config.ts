import type { NextConfig } from "next";

// Faste sikkerhedsheadere paa alle svar. Content-Security-Policy saettes i
// src/proxy.ts, fordi den indeholder en ny nonce for hver forespoergsel
// (se node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
const sikkerhedsHeadere = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Popups til fx 3DS/MobilePay maa stadig kunne aabnes og lukke tilbage.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // Alt slaaet fra undtagen betaling, som Stripe (Apple Pay/Google Pay) skal bruge.
  {
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "display-capture=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "usb=()",
      "browsing-topics=()",
      'payment=(self "https://js.stripe.com")',
    ].join(", "),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: sikkerhedsHeadere }];
  },
};

export default nextConfig;
