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

// next/image maa kun optimere offentlige billeder fra vores egne Supabase-
// projekter (auktionsbilleder og avatarer). Alt andet afvises med 400.
const supabaseBilleder = ["lkifkrexeldimmghnsie", "pjiigmzqwlfepxnjdvug"].map(
  (ref) =>
    ({
      protocol: "https",
      hostname: `${ref}.supabase.co`,
      port: "",
      pathname: "/storage/v1/object/public/**",
      search: "",
    }) as const,
);

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // next dev maa ikke omskrive AGENTS.md/CLAUDE.md (vi vedligeholder dem selv).
  // Se node_modules/next/dist/docs/01-app/02-guides/ai-agents.md ("Opting out").
  agentRules: false,
  // Server actions logges ikke med navn og argumenter i terminalen (kun i
  // udvikling) - argumenterne kan være adgangskoder, e-mails og engangskoder.
  // Se node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/logging.md.
  logging: { serverFunctions: false },
  // /betingelser og /privatliv læser jura/*-udkast.md ved runtime (siderne er
  // dynamiske pga. CSP-nonce i root-layoutet). Sikrer, at filerne kommer med
  // i serverbundlen på Vercel.
  outputFileTracingIncludes: {
    "/betingelser": ["./jura/brugerbetingelser-udkast.md"],
    "/privatliv": ["./jura/privatlivspolitik-udkast.md"],
    // "Download dine data" som PDF læser skrifttypen (æøå) ved runtime.
    "/konto/data": ["./src/lib/pdf/skrifter/*.ttf"],
  },
  images: {
    remotePatterns: supabaseBilleder,
    formats: ["image/avif", "image/webp"],
  },
  async headers() {
    // Admin på egen host (ADMIN_VAERT, docs/ADMIN-VAERT.md): ingen Referer ud
    // af admin og aldrig indeksering. Proxyen sætter de samme headere (plus
    // Cache-Control) - reglen her dækker også de statiske filer, proxyen
    // springer over. Den sidste regel vinder ved samme header.
    const adminVaert = (process.env.ADMIN_VAERT ?? "").trim().toLowerCase().split(":")[0];
    return [
      { source: "/(.*)", headers: sikkerhedsHeadere },
      ...(adminVaert
        ? [
            {
              source: "/(.*)",
              has: [{ type: "host" as const, value: `^${adminVaert.replace(/[^a-z0-9-]/g, (t) => `\\${t}`)}$` }],
              headers: [
                { key: "Referrer-Policy", value: "no-referrer" },
                { key: "X-Robots-Tag", value: "noindex, nofollow" },
              ],
            },
          ]
        : []),
    ];
  },
};

export default nextConfig;
