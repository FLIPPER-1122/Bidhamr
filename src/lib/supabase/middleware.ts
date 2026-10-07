import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { erTestdatabase } from "@/lib/miljoe";
import { tilmeldingAaben } from "@/lib/tilmelding";

// Routes der er tilgængelige uden login, mens resten af appen er bag
// venteliste-gaten. Kun API-ruter med egen adgangskontrol undtages:
// /api/waitlist (offentlig tilmelding fra splash-siden), /api/webhooks
// (Stripe-signatur), /api/fragt/webhook (fragtfirmaets signatur, verificeret
// af adapteren, fail closed) og /api/cron (CRON_SECRET, fail closed). Alle andre
// /api-ruter kræver login + rolle som resten af appen.
// /api/statistik er den cookiefri besøgsstatistik (gemmer kun antal pr. dag og
// kendt sidetype, rate-limit pr. IP), så også besøg på venteliste-siden tælles.
// /api/konto/slet er appens kontosletning: kun Bearer-token (ingen cookies),
// adgangskode og "SLET" tjekkes i ruten selv.
// /api/helbred er sundhedstjekket til uptime-tjenesten: svarer kun {ok}, ingen
// detaljer, grænse pr. IP i ruten selv.
// /robots.txt og /sitemap.xml skal kunne hentes af søgemaskiner; de siger selv
// "Disallow: /" og er tomme, indtil SEO_INDEKSERING=true (src/lib/seo.ts).
// Statiske filer (public/, delebilledet opengraph-image.jpg, ikoner) rammer
// kun proxyen, hvis forespørgslen har en krop eller en Next-Action-header
// (matcher i src/proxy.ts) - og så gælder gaten herunder.
// /signup, /tjek-indbakke og /konto-slettet er offentlige, fordi man ikke er
// logget ind dér. /cookies (cookiepolitikken) skal kunne læses af alle, også
// før login, fordi cookie-banneret linker til den. /signup lukker selv, så længe tilmeldingen er lukket
// (src/lib/tilmelding.ts).
// /dsa (kontaktpunkt, anmeld ulovligt indhold, status og klage) og /api/dsa
// (appens anmeldelse) skal kunne nås af alle, også før lancering og uden login
// (DSA art. 12 og 16).
// /api/offentlig er de få handlinger, der skal virke for en indlogget
// almindelig bruger på en offentlig side, mens siden er lukket (ny adgangskode,
// DSA-anmeldelse og -klage) - se src/app/api/offentlig/[handling]/route.ts.
const OFFENTLIGE_RUTER = [
  "/coming-soon",
  "/bidhamr-beskyttelse",
  "/cookies",
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
  "/api/konto/slet",
  "/api/helbred",
  "/robots.txt",
  "/sitemap.xml",
  "/dsa",
  "/api/dsa",
  "/api/offentlig",
];

// Rene læsesider, der skal kunne læses af alle uden login, også før lancering
// (brugerbetingelser og privatlivspolitik linkes fra signup og footer). Kun
// GET/HEAD er offentlige - alle andre metoder (fx et server action-kald via
// POST) går gennem den almindelige gate herunder.
const OFFENTLIGE_LAESESIDER = ["/betingelser", "/privatliv"];

function erOffentligLaeseside(pathname: string, metode: string) {
  if (metode !== "GET" && metode !== "HEAD") return false;
  return OFFENTLIGE_LAESESIDER.some(
    (rute) => pathname === rute || pathname.startsWith(`${rute}/`),
  );
}

// Inden launch er appen lukket for almindelige brugere. Kun disse roller
// slipper igennem - alle andre (også indloggede) sendes til splash-siden.
const ROLLER_MED_ADGANG = ["chef", "admin", "medarbejder"];

function erOffentligRute(pathname: string) {
  return OFFENTLIGE_RUTER.some(
    (rute) => pathname === rute || pathname.startsWith(`${rute}/`),
  );
}

// Server actions kan kaldes med POST til en HVILKEN SOM HELST sti - også de
// offentlige (/login, /coming-soon, /cookies ...), som gaten herunder springer
// over. Uden dette tjek kunne en indlogget almindelig bruger kalde fx afgivBud
// eller opretAuktion via POST /login, mens siden er lukket for alle andre end
// medarbejdere. Det gælder også uden Next-Action-header: formularer uden
// JavaScript sender action-id'et i en multipart-krop.
//
// Action-id'er er hashes, der skifter ved hvert build, så de kan ikke
// hvidlistes pålideligt. Derfor tjekkes brugeren i stedet. Mens tilmeldingen
// er lukket (TILMELDING_AABEN ikke 'true', src/lib/tilmelding.ts), afvises
// ALLE forespørgsler, der ikke er GET/HEAD, på en offentlig sidesti, medmindre:
//   - brugeren ikke er logget ind (login, signup, glemt adgangskode), eller
//   - brugeren har en staff-rolle (som slipper gennem gaten alligevel).
// Undtaget er /api/* og /auth/*: det er route handlers, som ikke kan køre
// server actions, og som har deres egne tjek (cron, webhooks, helbred ...).
// Auth-siderne (/login, /reset-password ...) undtages IKKE: et action-id kan
// sendes til enhver sidesti, så én undtaget side ville åbne for alle actions.
// Det, en indlogget almindelig bruger skal kunne dér (gemme ny adgangskode,
// DSA-anmeldelse og -klage), går i stedet via /api/offentlig/<handling>.
// På testdatabasen er tilmeldingen altid åben, så tjekket er slået fra dér -
// ligesom rolle-gaten.
function erRouteHandlerSti(pathname: string) {
  return pathname.startsWith("/api/") || pathname.startsWith("/auth/");
}

async function afvisSkrivningPaaOffentligSti(
  request: NextRequest,
  supabase: ReturnType<typeof createServerClient>,
): Promise<boolean> {
  if (request.method === "GET" || request.method === "HEAD") return false;
  if (erRouteHandlerSti(request.nextUrl.pathname)) return false;
  if (tilmeldingAaben()) return false;

  const { data } = await supabase.auth.getUser();
  if (!data.user) return false;

  const { data: rolle } = await supabase.rpc("min_rolle");
  return typeof rolle !== "string" || !ROLLER_MED_ADGANG.includes(rolle);
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
  if (erOffentligLaeseside(pathname, request.method)) {
    return supabaseResponse;
  }

  if (erOffentligRute(pathname)) {
    if (await afvisSkrivningPaaOffentligSti(request, supabase)) {
      return new NextResponse("Ingen adgang", { status: 403 });
    }
    return supabaseResponse;
  }

  const { data } = await supabase.auth.getUser();

  // Ikke logget ind og forsøger at tilgå noget andet end de offentlige ruter
  // -> hele appen er bag venteliste-gaten, ingen adgang uden login.
  if (!data.user) {
    return NextResponse.redirect(new URL("/coming-soon", request.url));
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
