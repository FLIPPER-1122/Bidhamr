import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { erTestdatabase } from "@/lib/miljoe";
import { manglerToTrin, TO_TRIN_STI } from "@/lib/mfa";

// Routes der er tilgængelige uden login, mens resten af appen er bag
// venteliste-gaten. Kun API-ruter med egen adgangskontrol undtages:
// /api/waitlist (offentlig tilmelding fra splash-siden), /api/webhooks
// (Stripe-signatur), /api/fragt/webhook (fragtfirmaets signatur, verificeret
// af adapteren, fail closed) og /api/cron (CRON_SECRET, fail closed). Alle andre
// /api-ruter kræver login + rolle som resten af appen.
// /api/statistik er den cookiefri besøgsstatistik (gemmer kun antal pr. dag og
// kendt sidetype, rate-limit pr. IP), så også besøg på venteliste-siden tælles.
// /robots.txt og /sitemap.xml skal kunne hentes af søgemaskiner; de siger selv
// "Disallow: /" og er tomme, indtil SEO_INDEKSERING=true (src/lib/seo.ts).
// Delebilleder (opengraph-image.jpg) rammer slet ikke proxyen (matcher i src/proxy.ts).
// /signup, /tjek-indbakke og /konto-slettet er offentlige, fordi man ikke er
// logget ind dér. /signup lukker selv, så længe tilmeldingen er lukket
// (src/lib/tilmelding.ts). /login dækker også /login/to-trin.
const OFFENTLIGE_RUTER = [
  "/coming-soon",
  "/bidhamr-beskyttelse",
  "/login",
  "/signup",
  "/tjek-indbakke",
  "/konto-slettet",
  "/glemt-adgangskode",
  "/nulstil-adgangskode",
  "/reset-password",
  "/auth",
  "/api/waitlist",
  "/api/webhooks",
  "/api/fragt/webhook",
  "/api/cron",
  "/api/statistik",
  "/robots.txt",
  "/sitemap.xml",
];

// Inden launch er appen lukket for almindelige brugere. Kun disse roller
// slipper igennem - alle andre (også indloggede) sendes til splash-siden.
const ROLLER_MED_ADGANG = ["chef", "admin", "medarbejder"];

function erOffentligRute(pathname: string) {
  return OFFENTLIGE_RUTER.some(
    (rute) => pathname === rute || pathname.startsWith(`${rute}/`),
  );
}

// ekstraHeadere (fx CSP-nonce fra src/proxy.ts) sendes med til renderingen.
// Headerne bygges fra request.headers hver gang, saa opdaterede cookies kommer med.
export async function updateSession(
  request: NextRequest,
  ekstraHeadere: Record<string, string> = {},
) {
  const naeste = () => {
    const headers = new Headers(request.headers);
    for (const [k, v] of Object.entries(ekstraHeadere)) headers.set(k, v);
    return NextResponse.next({ request: { headers } });
  };
  let supabaseResponse = naeste();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = naeste();
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { pathname } = request.nextUrl;

  // Offentlige ruter skal aldrig redirecte, uanset login-status.
  if (erOffentligRute(pathname)) {
    return supabaseResponse;
  }

  const { data } = await supabase.auth.getUser();

  // Ikke logget ind og forsøger at tilgå noget andet end de offentlige ruter
  // -> hele appen er bag venteliste-gaten, ingen adgang uden login.
  if (!data.user) {
    return NextResponse.redirect(new URL("/coming-soon", request.url));
  }

  // To-trins-login: har brugeren slået det til, men kun indtastet adgangskoden
  // (aal1), skal koden indtastes, før noget andet virker - også server actions
  // og API-ruter. Databasen afviser desuden aal1 (bidhamr_pre_request).
  if (await manglerToTrin(supabase, data.user)) {
    const url = new URL(TO_TRIN_STI, request.url);
    if (request.method === "GET") {
      url.searchParams.set("redirect", `${pathname}${request.nextUrl.search}`);
    }
    return NextResponse.redirect(url);
  }

  // På testdatabasen (kun npm run dev via .env.local) må alle indloggede
  // brugere komme forbi gaten, så almindelige testbrugere kan bruge siden.
  // Admin er stadig beskyttet af rolle-tjekket i src/app/admin/layout.tsx.
  // erTestdatabase() er fail closed, så produktion er uændret.
  if (erTestdatabase()) {
    return supabaseResponse;
  }

  // Logget ind er ikke nok inden launch: rollen skal give adgang.
  // rolle er ikke laesbar via kolonne-grants; min_rolle() bruger auth.uid().
  const { data: rolle } = await supabase.rpc("min_rolle");

  if (typeof rolle !== "string" || !ROLLER_MED_ADGANG.includes(rolle)) {
    return NextResponse.redirect(new URL("/coming-soon", request.url));
  }

  return supabaseResponse;
}
