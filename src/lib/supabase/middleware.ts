import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { foerLancering } from "@/lib/lancering";
import { ROLLE_COOKIE, laesRolleCookie, lavRolleCookie } from "@/lib/rolleCookie";
import { offentligNoegle } from "@/lib/supabase/noegler";

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
// /erhverv (info-siden og /erhverv/formular) skal virke før lancering, så
// firmaer kan skrive til os. Formularen sendes via /api/offentlig.
const OFFENTLIGE_RUTER = [
  "/erhverv",
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
// /bekraeft er mellemsiden for engangslinks i mails (én knap, der poster til
// /auth/callback) - den skal kunne vises for alle, også før lancering.
const OFFENTLIGE_LAESESIDER = ["/betingelser", "/privatliv", "/bekraeft"];

function erOffentligLaeseside(pathname: string, metode: string) {
  if (metode !== "GET" && metode !== "HEAD") return false;
  return OFFENTLIGE_LAESESIDER.some(
    (rute) => pathname === rute || pathname.startsWith(`${rute}/`),
  );
}

// Inden launch er appen lukket for almindelige brugere. Kun disse roller
// slipper igennem - alle andre (også indloggede) sendes til splash-siden.
// 'saelger' (erhvervssælger) skal kunne nå Admin → Erhverv før lancering -
// men KUN det: updateSession sender sælgeren til /admin/erhverv fra alle
// andre lukkede stier, og resten af admin afviser rollen (src/lib/adminAuth.ts).
const ROLLER_MED_ADGANG = ["chef", "admin", "medarbejder", "saelger"];

// Firmakonti (users.konto_type = 'erhverv') må før lancering KUN se Firma
// oversigt (/firma), så de er klar, når siden åbner (Filip, 8. okt. 2026).
// Alle andre lukkede sider sender firmaet til /firma, og firmaet kan ikke
// kalde server actions nogen steder (heller ikke på /firma - et action-id kan
// sendes til enhver sti). Pakkeskift på /firma går derfor via
// /api/offentlig/firma-skift-pakke. De offentlige ruter (login, /auth,
// /reset-password, /bekraeft, /betingelser ...) virker som for alle andre.
// Har en firmakonto også en staff-rolle, gælder staff-reglerne.
const FIRMA_KONTOTYPE = "erhverv";

function erFirmaSti(pathname: string) {
  return pathname === "/firma" || pathname.startsWith("/firma/");
}

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
// Firmakonti afvises også her (de har ingen staff-rolle).
// Undtaget er /api/* og /auth/*: det er route handlers, som ikke kan køre
// server actions, og som har deres egne tjek (cron, webhooks, helbred ...).
// Auth-siderne (/login, /reset-password ...) undtages IKKE: et action-id kan
// sendes til enhver sidesti, så én undtaget side ville åbne for alle actions.
// Det, en indlogget almindelig bruger skal kunne dér (gemme ny adgangskode,
// DSA-anmeldelse og -klage), går i stedet via /api/offentlig/<handling>.
// Efter lancering (på testdatabasen, se src/lib/lancering.ts) er tjekket slået
// fra - ligesom rolle-gaten. TILMELDING_AABEN læses direkte (ikke
// tilmeldingAaben()), fordi tilmeldingen altid er åben på testdatabasen -
// ellers kunne tjekket ikke testes med SIMULER_FOER_LANCERING.
function erRouteHandlerSti(pathname: string) {
  return pathname.startsWith("/api/") || pathname.startsWith("/auth/");
}

async function afvisSkrivningPaaOffentligSti(
  request: NextRequest,
  supabase: ReturnType<typeof createServerClient>,
): Promise<boolean> {
  if (request.method === "GET" || request.method === "HEAD") return false;
  if (erRouteHandlerSti(request.nextUrl.pathname)) return false;
  if (!foerLancering() || process.env.TILMELDING_AABEN === "true") return false;

  const session = await hentSession(supabase);
  if (!session) return false;

  const { rolle } = await hentGateIdentitet(request, supabase, session);
  // Sælgeren må kun bruge Admin → Erhverv før lancering - ikke kalde fx
  // afgivBud eller opretAuktion via POST til en offentlig sti.
  return !rolle || !ROLLER_MED_ADGANG.includes(rolle) || rolle === "saelger";
}

// En fil fra public/ (fx /placeholder.png), der ikke er undtaget i
// matcheren i src/proxy.ts. Kun GET/HEAD - en server action kan sendes til
// enhver sti, også en med filendelse.
function erStatiskFil(pathname: string, metode: string) {
  if (metode !== "GET" && metode !== "HEAD") return false;
  return /\/[^/]+\.(?:png|jpe?g|gif|webp|avif|svg|ico|txt|xml|webmanifest|json|woff2?)$/i.test(pathname);
}

type Session = { brugerId: string; sessionId: string | null };

// Gaten bruger getClaims(): JWT'en tjekkes lokalt med projektets offentlige
// nøgle (JWKS, ES256 - hentes én gang og caches), så der går INTET kald til
// Supabase Auth ved hvert klik. getClaims fornyer også en udløbet session
// (cookies sættes via setAll ovenfor), ligesom getUser gjorde. Er JWT'en
// signeret med den gamle fælles hemmelighed (HS256), falder getClaims selv
// tilbage til getUser (et netværkskald) - så er det lige så sikkert som før.
// Forskellen: en session, der er logget ud andetsteds, men hvis JWT endnu
// ikke er udløbet (højst 1 time), kommer forbi GATEN. Siderne og server
// actions validerer stadig brugeren med getUser (src/lib/supabase/bruger.ts
// og src/lib/hentBruger.ts), og RLS i databasen tjekker JWT'en selv.
async function hentSession(
  supabase: ReturnType<typeof createServerClient>,
): Promise<Session | null> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;
  const { sub, session_id: sessionId } = data.claims;
  if (typeof sub !== "string" || !sub) return null;
  return { brugerId: sub, sessionId: typeof sessionId === "string" ? sessionId : null };
}

// Rolle og konto_type til gaten: fra den signerede rolle-cookie, hvis den er
// gyldig for netop denne bruger og session (src/lib/rolleCookie.ts), ellers
// fra databasen (min_rolle og users.konto_type, samtidig - så det tager ikke
// længere end før). En staff-rolle eller en firmakonto fra databasen gemmes i
// en ny cookie, så de næste klik i 5 minutter ikke venter på databasen.
// Besøgende uden login når aldrig hertil (ingen opslag for dem).
function faarCookie(rolle: string | null, kontoType: string | null) {
  return (!!rolle && ROLLER_MED_ADGANG.includes(rolle)) || kontoType === FIRMA_KONTOTYPE;
}

async function hentGateIdentitet(
  request: NextRequest,
  supabase: ReturnType<typeof createServerClient>,
  session: Session,
): Promise<{
  rolle: string | null;
  kontoType: string | null;
  nyCookie: { vaerdi: string; maxAge: number } | null;
}> {
  if (session.sessionId) {
    const fraCookie = await laesRolleCookie(
      request.cookies.get(ROLLE_COOKIE)?.value,
      session.brugerId,
      session.sessionId,
    );
    if (fraCookie && faarCookie(fraCookie.rolle, fraCookie.kontoType)) {
      return { rolle: fraCookie.rolle, kontoType: fraCookie.kontoType, nyCookie: null };
    }
  }
  // rolle er ikke laesbar via kolonne-grants; min_rolle() bruger auth.uid().
  // konto_type kan læses af alle (20261010030000_erhverv.sql).
  const [{ data: rolleData }, { data: kontoData }] = await Promise.all([
    supabase.rpc("min_rolle"),
    supabase
      .from("users")
      .select("konto_type")
      .eq("id", session.brugerId)
      .maybeSingle(),
  ]);
  const rolle = typeof rolleData === "string" ? rolleData : null;
  const konto = (kontoData as { konto_type?: unknown } | null)?.konto_type;
  const kontoType = typeof konto === "string" ? konto : null;
  const nyCookie =
    rolle && faarCookie(rolle, kontoType) && session.sessionId
      ? await lavRolleCookie(session.brugerId, session.sessionId, rolle, kontoType)
      : null;
  return { rolle, kontoType, nyCookie };
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
    offentligNoegle(),
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

  // Lokal JWT-tjek (se hentSession) - intet kald til Supabase Auth.
  const session = await hentSession(supabase);

  // Ikke logget ind og forsøger at tilgå noget andet end de offentlige ruter
  // -> hele appen er bag venteliste-gaten, ingen adgang uden login.
  if (!session) {
    return NextResponse.redirect(new URL("/coming-soon", request.url));
  }

  // Efter lancering (i dag kun på testdatabasen - npm run dev via .env.local,
  // se src/lib/lancering.ts) må alle indloggede brugere komme forbi gaten, så
  // almindelige testbrugere kan bruge siden. Admin er stadig beskyttet af
  // rolle-tjekket i src/app/admin/layout.tsx. foerLancering() er fail closed,
  // så produktion er uændret. Admin-stier tjekkes dog altid for rollen
  // 'saelger' herunder.
  const lukket = foerLancering();
  const erAdminSti = pathname === "/admin" || pathname.startsWith("/admin/");
  if (!lukket && !erAdminSti) {
    return supabaseResponse;
  }

  // Logget ind er ikke nok inden launch: rollen (eller en firmakonto) skal
  // give adgang. Den læses fra den signerede rolle-cookie (højst 5 min.
  // gammel) eller databasen - se hentGateIdentitet.
  const { rolle, kontoType, nyCookie } = await hentGateIdentitet(request, supabase, session);

  const medCookie = (res: NextResponse) => {
    if (nyCookie) {
      res.cookies.set(ROLLE_COOKIE, nyCookie.vaerdi, {
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/",
        maxAge: nyCookie.maxAge,
      });
    }
    return res;
  };

  const erStaff = !!rolle && ROLLER_MED_ADGANG.includes(rolle);
  if (lukket && !erStaff) {
    // Firmakonto før lancering: kun /firma (læsning) og statiske filer.
    // Skrivninger (server actions) afvises overalt, også på /firma.
    if (kontoType === FIRMA_KONTOTYPE) {
      const laesning = request.method === "GET" || request.method === "HEAD";
      if (!laesning) return new NextResponse("Ingen adgang", { status: 403 });
      if (erFirmaSti(pathname) || erStatiskFil(pathname, request.method)) return medCookie(supabaseResponse);
      return medCookie(NextResponse.redirect(new URL("/firma", request.url)));
    }
    return NextResponse.redirect(new URL("/coming-soon", request.url));
  }

  // Rollen 'saelger' (erhvervssælger) har kun adgang til Admin → Erhverv.
  // Hver admin-side og action afviser rollen også selv (src/lib/adminAuth.ts);
  // dette er et ekstra værn, så sælgeren aldrig ser en anden admin-side.
  // Før lancering (gaten her) kommer sælgeren heller ikke ind i resten af den
  // lukkede app (auktioner, byd, opret auktion ...) - kun /admin/erhverv*,
  // de offentlige ruter ovenfor (login, /auth, /api/offentlig ...) og
  // statiske filer. Log ud sker i browseren direkte mod Supabase.
  // Offentlige stier: skrivninger (server actions) afvises for sælgeren i
  // afvisSkrivningPaaOffentligSti. På testdatabasen (efter-lancering-
  // tilstand) må sælgeren som alle andre bruge siden - admin er stadig låst.
  const saelgerUdenforErhverv =
    rolle === "saelger" &&
    pathname !== "/admin/erhverv" &&
    !pathname.startsWith("/admin/erhverv/") &&
    (erAdminSti || (lukket && !erStatiskFil(pathname, request.method)));
  if (saelgerUdenforErhverv) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new NextResponse("Ingen adgang", { status: 403 });
    }
    return NextResponse.redirect(new URL("/admin/erhverv", request.url));
  }

  return medCookie(supabaseResponse);
}
