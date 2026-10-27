import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { foerLancering } from "@/lib/lancering";
import { ROLLE_COOKIE, laesRolleCookie, lavRolleCookie } from "@/lib/rolleCookie";
import { offentligNoegle } from "@/lib/supabase/noegler";
import { adminCookieOptions, adminUrl, adminVaertKonfig, hovedDomaeneLukning } from "@/lib/adminVaert";
import {
  ADMIN_HEADERE,
  ROBOTS_ADMIN,
  adminGateBeslutning,
  adminGateKraeverRolle,
  adminRute,
  adminSessionTilstand,
  hovedAdminBeslutning,
  type GateBeslutning,
} from "@/lib/adminGateRegler";
import { toTrinMaksTimer } from "@/lib/staffToTrinRegler";

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
// /api/konto/opret og /api/konto/bekraeft er appens oprettelse af konti
// (docs/APP-SIGNUP.md): ingen cookies, ingen login - man har jo ingen konto
// endnu. Neutrale svar, rate limits og Origin-tjek i ruterne selv.
// /api/firma/skift-pakke er appens pakkeskift for firmakonti: kun
// Bearer-token (ingen cookies); login og firmakonto tjekkes i ruten/databasen.
// /api/betaling/kort er appens "Fjern kort": kun
// Bearer-token (ingen cookies); login tjekkes i ruten.
// /api/betaling/app er appens betaling, gemte kort og udbetalingskonto: kun
// Bearer-token (POST); /api/betaling/app/retur (GET) sender kun Stripes
// onboarding-retur videre til appens deep link - ingen data, ingen login.
// /api/faktura/<id> er PDF'en af en faktura (hjemmesiden med cookie, appen
// med Bearer-token); login og ejerskab tjekkes i ruten. Kun GET.
// /api/ekstra-fragt/<id>/dokumentation er sælgerens link til fragtfirmaets
// faktura (cookie eller Bearer-token; login og ejerskab tjekkes i ruten).
// /api/fragt/app er appens fragt (pakkeshops, leveringsvalg, label): kun
// Bearer-token (ingen cookies); login tjekkes i ruten.
// /api/helbred er sundhedstjekket til uptime-tjenesten: svarer kun {ok}, ingen
// detaljer, grænse pr. IP i ruten selv.
// /api/mitid er MitID-verificeringen (Idura): start kræver cookie-login eller
// appens engangs-token, callback kræver state-cookie + ubrugt forløb, og
// /api/mitid/app kræver Bearer-token - alt tjekkes i ruterne selv. Appens
// in-app browser har ingen session, så gaten må ikke stoppe den.
// /api/dac7/oplysninger er appens DAC7-skatteoplysninger: kun Bearer-token
// (ingen cookies); login tjekkes i ruten.
// /api/handel/app (handelstrin), /api/bud/app (bud), /api/auktion/app
// (billedoprydning), /api/konto/adgangskode, /api/konto/email (skift af
// e-mail) og /api/konto/data (dine data) er appens endpoints: kun Bearer-token (ingen cookies); login tjekkes i
// ruterne, som selv afviser med JSON (401 ikke_logget_ind) - ikke med
// proxyens tekst "Log ind først". /api/konto/glemt er "Glemt adgangskode":
// ingen login (som /glemt-adgangskode), grænser i ruten og samme svar,
// uanset om e-mailen findes. Se docs/APP-ENDPOINTS.md.
// /robots.txt og /sitemap.xml skal kunne hentes af søgemaskiner; de siger selv
// "Disallow: /" og er tomme, indtil SEO_INDEKSERING=true (src/lib/seo.ts).
// Statiske filer (public/, delebilledet opengraph-image.jpg, ikoner) rammer
// kun proxyen, hvis forespørgslen har en krop eller en Next-Action-header
// (matcher i src/proxy.ts) - og så gælder gaten herunder.
// /signup, /tjek-indbakke og /konto-slettet er offentlige, fordi man ikke er
// logget ind dér. /signup lukker selv, så længe tilmeldingen er lukket
// (src/lib/tilmelding.ts) - undtagen for inviterede, mens beta er åben (BETA).
// /dsa (kontaktpunkt, anmeld ulovligt indhold, status og klage) og /api/dsa
// (appens anmeldelse) skal kunne nås af alle, også før lancering og uden login
// (DSA art. 12 og 16).
// /api/offentlig er de få handlinger, der skal virke for en indlogget
// almindelig bruger på en offentlig side, mens siden er lukket (ny adgangskode,
// DSA-anmeldelse og -klage) - se src/app/api/offentlig/[handling]/route.ts.
// /erhverv (info-siden og /erhverv/formular) skal virke før lancering, så
// firmaer kan skrive til os. Formularen sendes via /api/offentlig.
// Før lancering må besøgende KUN se coming soon, erhverv og de lovpligtige
// sider (Filip, 26. okt. 2026) - /bidhamr-beskyttelse og /cookies er derfor
// ikke længere offentlige før lancering (se SIDER_MED_ADGANG_FOER_LANCERING
// og AABNE_SIDER_EFTER_LANCERING). Cookie-banneret, der linkede til /cookies,
// vises ikke før lancering for dem (src/lib/lukketUdgave.ts).
const OFFENTLIGE_RUTER = [
  "/erhverv",
  "/coming-soon",
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
  "/api/konto/opret",
  "/api/konto/bekraeft",
  "/api/firma/skift-pakke",
  "/api/betaling/kort",
  "/api/betaling/app",
  "/api/faktura",
  "/api/ekstra-fragt",
  "/api/fragt/app",
  "/api/helbred",
  "/api/mitid",
  "/api/dac7/oplysninger",
  "/api/handel/app",
  "/api/bud/app",
  "/api/auktion/app",
  "/api/konto/adgangskode",
  "/api/konto/email",
  "/api/konto/glemt",
  "/api/konto/data",
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

// Efter lancering (LANCERET=1 i produktion, altid på testdatabasen - se
// src/lib/lancering.ts) må besøgende UDEN login kigge rundt: forsiden,
// søgningen, en auktion, offentlige profiler og de faste tekstsider. Alt
// andet (Min konto, Mine handler, Opret auktion, beskeder, admin ...) kræver
// stadig login - besøgende uden login sendes til /login og tilbage bagefter.
// Server actions på disse stier tjekker selv brugeren (fx afgivBud), ligesom
// de altid har skullet på /login. Før lancering gælder listen ikke: så ser
// besøgende uden login kun /coming-soon og de offentlige ruter ovenfor.
const AABNE_SIDER_EFTER_LANCERING = [
  "/auktioner",
  "/bidhamr-beskyttelse",
  "/cookies",
  "/saadan-virker-det",
  "/faq",
  "/pakkeguide",
  "/forbudte-varer",
  "/om",
  "/kontakt",
  "/tilgaengelighed",
];
// /auktion/<id> (men ikke /auktion/<id>/rediger), /profil/<uuid> (men ikke
// /profil/mig) og /erhvervssaelger/<id>.
// /auktion/<id>/opengraph-image er auktionens delebillede
// (src/app/(app)/auktion/[id]/opengraph-image.tsx) - Facebook, Messenger og
// SMS henter det uden login. Før lancering gælder listen ikke (coming soon).
const AABNE_MOENSTRE_EFTER_LANCERING = [
  /^\/auktion\/[^/]+\/?$/,
  /^\/auktion\/[^/]+\/opengraph-image(?:-[A-Za-z0-9]+)?(?:\/[^/]+)?\/?$/,
  new RegExp(`^/profil/[0-9a-fA-F-]{36}/?$`),
  /^\/erhvervssaelger\/[^/]+\/?$/,
];

// Før lancering må firmakonti stadig læse disse to sider (som før de blev
// fjernet fra OFFENTLIGE_RUTER); staff og beta-testere kommer alligevel ind.
const SIDER_MED_ADGANG_FOER_LANCERING = ["/bidhamr-beskyttelse", "/cookies"];

function erSideMedAdgangFoerLancering(pathname: string) {
  return SIDER_MED_ADGANG_FOER_LANCERING.some((rute) => pathname === rute || pathname === `${rute}/`);
}

function erForside(pathname: string) {
  return pathname === "/";
}

// Efter lancering: de sider, der kræver login. Kun dem sender en besøgende
// uden login til /login - alle andre ukendte adresser går videre og giver en
// rigtig 404 (not-found.tsx) i stedet for et login-krav. /api/* og /dev/*
// står her, så route handlers uden for OFFENTLIGE_RUTER aldrig nås uden login.
// Tilføjes en ny side, der kræver login, skal den med her (siderne tjekker
// også selv brugeren - listen er kun til at sende pænt til /login).
const LOGIN_PAAKRAEVET_EFTER_LANCERING = [
  "/admin",
  "/api",
  "/dev",
  "/konto",
  "/mine-handler",
  "/opret-auktion",
  "/beskeder",
  "/favoritter",
  "/notifikationer",
  "/andenchance",
  "/velkommen",
  "/firma",
  "/profil/mig",
];
// /auktion/<id>/rediger (og alt under en auktion ud over selve siden).
const LOGIN_PAAKRAEVET_MOENSTRE = [/^\/auktion\/[^/]+\/.+/];

export function kraeverLoginEfterLancering(pathname: string) {
  if (LOGIN_PAAKRAEVET_EFTER_LANCERING.some((rute) => pathname === rute || pathname.startsWith(`${rute}/`))) {
    return true;
  }
  return LOGIN_PAAKRAEVET_MOENSTRE.some((m) => m.test(pathname));
}

export function erAabenEfterLancering(pathname: string) {
  if (pathname === "/") return true;
  if (AABNE_SIDER_EFTER_LANCERING.some((rute) => pathname === rute || pathname === `${rute}/`)) return true;
  return AABNE_MOENSTRE_EFTER_LANCERING.some((m) => m.test(pathname));
}

export function erOffentligLaeseside(pathname: string, metode: string) {
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
// Lukkede stier sendes til den tilsvarende side i dashboardet
// (firmaOmdirigering, fx /mine-handler/<id> -> /firma/salg/<id>).
// Efter lancering er gaten slået fra for alle: firmaets server actions virker
// så (også på /firma/*), og firmaet må se de offentlige sider - men "min
// konto"-siderne sender stadig firmaet til dashboardet (se updateSession).
const FIRMA_KONTOTYPE = "erhverv";

// BETA (Filip, 11. okt. 2026 - docs/BETA-TEST.md): en indlogget bruger med en
// aktiv beta-invitation, mens chefen har beta åben (min_beta_adgang i
// 20261017010000_beta_invitationer.sql), må før lancering bruge hele den
// private del af siden og kalde server actions - som efter lancering. Men
// ALDRIG admin: /admin* sender beta-brugeren til forsiden (admin-layoutet og
// hver admin-action tjekker desuden rollen i databasen). Firmakonti og staff
// følger deres egne regler, også hvis de har en invitation. Svaret ligger i
// den signerede rolle-cookie i højst 5 minutter, så en lukket beta eller en
// tilbagekaldt invitation slår igennem inden for 5 minutter.
function erBetaBruger(rolle: string | null, kontoType: string | null, beta: boolean) {
  if (!beta) return false;
  if (kontoType === FIRMA_KONTOTYPE) return false;
  return !(rolle && ROLLER_MED_ADGANG.includes(rolle));
}

function erFirmaSti(pathname: string) {
  return pathname === "/firma" || pathname.startsWith("/firma/");
}

// Firma-dashboardet (/firma/*) har sin egen udgave af de almindelige "min
// konto"-sider. En firmakonto sendes altid dertil - også efter lancering - så
// firmaet aldrig farer vild (links i mails og notifikationer peger fx på
// /mine-handler/<id>). Offentlige sider (forsiden, auktioner, søgning, en
// auktion, firmaprofilen) må firmaet gerne se efter lancering.
// Returnerer stien i dashboardet, eller null hvis stien ikke skal omdirigeres.
const UUID_DEL = "[0-9a-fA-F-]{36}";
const FIRMA_KORT: [RegExp, (m: RegExpMatchArray) => string][] = [
  [new RegExp(`^/mine-handler/(${UUID_DEL})/kvittering/?$`), (m) => `/firma/salg/${m[1]}/kvittering`],
  [new RegExp(`^/mine-handler/(${UUID_DEL})/?$`), (m) => `/firma/salg/${m[1]}`],
  [/^\/mine-handler(\/.*)?$/, () => "/firma/salg"],
  [/^\/opret-auktion\/?$/, () => "/firma/auktioner/ny"],
  [new RegExp(`^/auktion/(${UUID_DEL})/rediger/?$`), (m) => `/firma/auktioner/${m[1]}/rediger`],
  // /konto/* -> /firma, undtagen /konto/data ("Download dine data", GDPR):
  // formularen på /firma/oplysninger poster dertil (kun POST, så kortet her
  // rammer den alligevel ikke - undtagelsen er et ekstra værn).
  [/^\/konto(?:\/(?!data(?:\/|$)).*)?$/, () => "/firma"],
  [/^\/(beskeder|favoritter|notifikationer|andenchance|velkommen)(\/.*)?$/, () => "/firma"],
  [/^\/profil\/mig\/?$/, () => "/firma"],
];

// Egen profil (/profil/<eget id> og alt under den, fx ?fane=indstillinger)
// er privat-ejer-visningen med "Rediger profil", "Mine bud" og e-mail - den
// har firmaet i dashboardet. Id'et i stien sammenlignes med bruger-id'et fra
// sessionens JWT (lokalt, intet opslag), så kun firmaets EGEN profil slår
// identiteten op. Andres profiler (også et andet firmas) er offentlige.
// Siden selv omdirigerer også (src/app/(app)/profil/[id]/page.tsx).
const EGEN_PROFIL = new RegExp(`^/profil/(${UUID_DEL})(?:/.*)?$`);

function firmaOmdirigering(pathname: string, brugerId: string): string | null {
  for (const [moenster, til] of FIRMA_KORT) {
    const m = pathname.match(moenster);
    if (m) return til(m);
  }
  const egen = pathname.match(EGEN_PROFIL);
  if (egen && egen[1].toLowerCase() === brugerId.toLowerCase()) return "/firma";
  return null;
}

// Omdirigering til dashboardet. Forespørgslens søgeparametre følger kun med
// til "Opret auktion" (fx ?stripe=retur fra udbetalingskontoen).
function firmaRedirectUrl(request: NextRequest, til: string): URL {
  const url = new URL(til, request.url);
  if (til === "/firma/auktioner/ny") url.search = request.nextUrl.search;
  return url;
}

export function erOffentligRute(pathname: string) {
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
// Firmakonti afvises her før lancering UANSET TILMELDING_AABEN: firmaet må
// ikke kalde server actions før lancering (se FIRMA_KONTOTYPE ovenfor).
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
  if (!foerLancering()) return false;

  const session = await hentSession(supabase);
  if (!session) return false;

  const { rolle, kontoType, beta } = await hentGateIdentitet(request, supabase, session);
  // Sælgeren må kun bruge Admin → Erhverv før lancering - ikke kalde fx
  // afgivBud eller opretAuktion via POST til en offentlig sti.
  const staff = !!rolle && ROLLER_MED_ADGANG.includes(rolle) && rolle !== "saelger";
  if (kontoType === FIRMA_KONTOTYPE && !staff) return true;
  if (process.env.TILMELDING_AABEN === "true") return false;
  // Beta-testere må bruge siden som alle andre efter lancering (se BETA).
  if (erBetaBruger(rolle, kontoType, beta)) return false;
  return !staff;
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
// længere end før). Svaret fra databasen gemmes i en ny cookie - for ALLE
// brugere (staff, firmakonti og private), så de næste klik i 5 minutter ikke
// venter på databasen. Efter lancering slår gaten identiteten op på "min
// konto"-stierne for at sende en firmakonto til dashboardet; uden cookien
// kostede det private brugere to databasekald ved hvert klik dér.
// Cookien giver ingen adgang i sig selv: den er signeret, bundet til bruger og
// session og gælder højst 5 minutter, og admin, staff-handlinger og RLS
// tjekker stadig databasen.
// Besøgende uden login når aldrig hertil (ingen opslag for dem).
// Før lancering slås beta-adgangen op samtidig (min_beta_adgang, auth.uid()).
// Fejler opslaget (fx migrationen ikke kørt), er svaret false (fail closed).
// Efter lancering spørges der ikke, og cookien siger bare "ingen beta".

async function hentGateIdentitet(
  request: NextRequest,
  supabase: ReturnType<typeof createServerClient>,
  session: Session,
): Promise<{
  rolle: string | null;
  kontoType: string | null;
  beta: boolean;
  nyCookie: { vaerdi: string; maxAge: number } | null;
}> {
  if (session.sessionId) {
    const fraCookie = await laesRolleCookie(
      request.cookies.get(ROLLE_COOKIE)?.value,
      session.brugerId,
      session.sessionId,
    );
    if (fraCookie) {
      return { rolle: fraCookie.rolle, kontoType: fraCookie.kontoType, beta: fraCookie.beta, nyCookie: null };
    }
  }
  // rolle er ikke laesbar via kolonne-grants; min_rolle() bruger auth.uid().
  // konto_type kan læses af alle (20261010030000_erhverv.sql).
  const [{ data: rolleData }, { data: kontoData }, { data: betaData }] = await Promise.all([
    supabase.rpc("min_rolle"),
    supabase
      .from("users")
      .select("konto_type")
      .eq("id", session.brugerId)
      .maybeSingle(),
    foerLancering() ? supabase.rpc("min_beta_adgang") : Promise.resolve({ data: false }),
  ]);
  const rolle = typeof rolleData === "string" ? rolleData : null;
  const konto = (kontoData as { konto_type?: unknown } | null)?.konto_type;
  const kontoType = typeof konto === "string" ? konto : null;
  const beta = betaData === true;
  const nyCookie =
    rolle && session.sessionId
      ? await lavRolleCookie(session.brugerId, session.sessionId, rolle, kontoType, beta)
      : null;
  return { rolle, kontoType, beta, nyCookie };
}

function saetRolleCookie(
  request: NextRequest,
  res: NextResponse,
  nyCookie: { vaerdi: string; maxAge: number } | null,
): NextResponse {
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
}

// "Download dine data" (src/app/(app)/konto/data/route.ts) er en route
// handler (kan ikke køre server actions) og kun POST. En firmakonto må bruge
// den før lancering (GDPR), selvom firmaet ellers ikke må skrive noget.
function erDataEksport(pathname: string, metode: string) {
  return metode === "POST" && (pathname === "/konto/data" || pathname === "/konto/data/");
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

  // Før lancering vises coming soon DIREKTE på forsiden "/" (rewrite, ikke
  // redirect), så Google indekserer bidhamr.dk/ (Filip, 26. okt. 2026).
  // Session-cookies (evt. fornyet) følger med.
  const comingSoonPaaForside = () => {
    const headers = new Headers(request.headers);
    for (const [k, v] of Object.entries(ekstraHeadere)) headers.set(k, v);
    const res = NextResponse.rewrite(new URL("/coming-soon", request.url), { request: { headers } });
    for (const c of supabaseResponse.cookies.getAll()) res.cookies.set(c);
    return res;
  };
  const erLaesning = request.method === "GET" || request.method === "HEAD";

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

  // Admin på egen host (ADMIN_VAERT): /adgang findes kun dér, og /admin
  // lukkes efter ADMIN_LUK_HOVEDDOMAENE (src/lib/adminGateRegler.ts). Uden
  // ADMIN_VAERT er hovedsitet uændret.
  const hoved = hovedAdminBeslutning(pathname, request.method, hovedDomaeneLukning());
  if (hoved) return gateSvar(request, hoved);

  // Offentlige ruter skal aldrig redirecte, uanset login-status.
  if (erOffentligLaeseside(pathname, request.method)) {
    return supabaseResponse;
  }

  // Efter lancering er venteliste-siden overflødig: gamle links og
  // bogmærker sendes til forsiden. Hash-fragmentet (#access_token=... fra
  // Supabase) bevares af browseren gennem omdirigeringen, og forsiden har
  // samme AuthHashRedirect som coming-soon.
  if (
    (pathname === "/coming-soon" || pathname === "/coming-soon/") &&
    (request.method === "GET" || request.method === "HEAD") &&
    !foerLancering()
  ) {
    return NextResponse.redirect(new URL("/", request.url));
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
  // Efter lancering: de åbne sider (forside, søgning, auktion ...) og
  // statiske filer må ses uden login; resten sender til /login.
  if (!session) {
    if (!foerLancering()) {
      if (erAabenEfterLancering(pathname) || erStatiskFil(pathname, request.method)) {
        return supabaseResponse;
      }
      // Ukendte adresser (ikke åbne og ikke en side, der kræver login) går
      // videre til Next, som svarer med en rigtig 404. Kun læsninger - en
      // server action kan sendes til enhver sti og afvises herunder.
      if (erLaesning && !kraeverLoginEfterLancering(pathname)) {
        return supabaseResponse;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const login = new URL("/login", request.url);
        login.searchParams.set("redirect", `${pathname}${request.nextUrl.search}`);
        return NextResponse.redirect(login);
      }
      return new NextResponse("Log ind først", { status: 401 });
    }
    if (erForside(pathname) && erLaesning) return comingSoonPaaForside();
    return NextResponse.redirect(new URL("/coming-soon", request.url));
  }

  // Efter lancering (på testdatabasen altid - npm run dev via .env.local - og
  // i produktion først når LANCERET=1, se src/lib/lancering.ts) må alle
  // indloggede brugere komme forbi gaten. Admin er stadig beskyttet af
  // rolle-tjekket i src/app/admin/layout.tsx. foerLancering() er fail closed,
  // så produktion er uændret. Admin-stier tjekkes dog altid for rollen
  // 'saelger' herunder.
  const lukket = foerLancering();
  const erAdminSti = pathname === "/admin" || pathname.startsWith("/admin/");
  if (!lukket && !erAdminSti) {
    // Efter lancering: en firmakonto sendes fra "min konto"-siderne til
    // firma-dashboardet (firmaOmdirigering). Kun GET/HEAD - en server action
    // kan sendes til enhver sti og må ikke omdirigeres. Identiteten slås kun
    // op på netop de stier, og svaret gemmes i den signerede cookie for alle
    // (også private), så de næste klik i 5 minutter ikke koster opslag.
    const til = request.method === "GET" || request.method === "HEAD" ? firmaOmdirigering(pathname, session.brugerId) : null;
    if (til) {
      const id = await hentGateIdentitet(request, supabase, session);
      const staff = !!id.rolle && ROLLER_MED_ADGANG.includes(id.rolle) && id.rolle !== "saelger";
      if (id.kontoType === FIRMA_KONTOTYPE && !staff) {
        return saetRolleCookie(request, NextResponse.redirect(firmaRedirectUrl(request, til)), id.nyCookie);
      }
      return saetRolleCookie(request, supabaseResponse, id.nyCookie);
    }
    return supabaseResponse;
  }

  // Logget ind er ikke nok inden launch: rollen (eller en firmakonto) skal
  // give adgang. Den læses fra den signerede rolle-cookie (højst 5 min.
  // gammel) eller databasen - se hentGateIdentitet.
  const { rolle, kontoType, beta, nyCookie } = await hentGateIdentitet(request, supabase, session);

  const medCookie = (res: NextResponse) => saetRolleCookie(request, res, nyCookie);

  const erStaff = !!rolle && ROLLER_MED_ADGANG.includes(rolle);
  if (lukket && !erStaff) {
    // Firmakonto før lancering: kun /firma (læsning) og statiske filer.
    // Skrivninger (server actions) afvises overalt, også på /firma.
    if (kontoType === FIRMA_KONTOTYPE) {
      const laesning = request.method === "GET" || request.method === "HEAD";
      if (erDataEksport(pathname, request.method)) return medCookie(supabaseResponse);
      if (!laesning) return new NextResponse("Ingen adgang", { status: 403 });
      if (erFirmaSti(pathname) || erStatiskFil(pathname, request.method) || erSideMedAdgangFoerLancering(pathname)) {
        return medCookie(supabaseResponse);
      }
      return medCookie(NextResponse.redirect(firmaRedirectUrl(request, firmaOmdirigering(pathname, session.brugerId) ?? "/firma")));
    }
    // Beta-tester: hele den private del af siden, men aldrig admin.
    if (erBetaBruger(rolle, kontoType, beta)) {
      if (erAdminSti) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return medCookie(new NextResponse("Ingen adgang", { status: 403 }));
        }
        return medCookie(NextResponse.redirect(new URL("/", request.url)));
      }
      return medCookie(supabaseResponse);
    }
    if (erForside(pathname) && erLaesning) return medCookie(comingSoonPaaForside());
    return medCookie(NextResponse.redirect(new URL("/coming-soon", request.url)));
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
    (erAdminSti || (lukket && !erStatiskFil(pathname, request.method) && !erSideMedAdgangFoerLancering(pathname)));
  if (saelgerUdenforErhverv) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new NextResponse("Ingen adgang", { status: 403 });
    }
    // Med ADMIN_VAERT ligger Erhverv på admin-hosten.
    return NextResponse.redirect(tilAdminVaert(request, "/admin/erhverv"));
  }

  return medCookie(supabaseResponse);
}

// --- Admin på egen host (ADMIN_VAERT) -----------------------------------------
// docs/ADMIN-VAERT.md. Reglerne er rene funktioner i src/lib/adminGateRegler.ts.

// Fuld adresse på admin-hosten (NEXT_PUBLIC_ADMIN_URL, ellers samme protokol
// og port som forespørgslen med ADMIN_VAERT som host). Uden ADMIN_VAERT: samme
// host som før.
function tilAdminVaert(request: NextRequest, sti: string): URL {
  const vaert = adminVaertKonfig();
  if (!vaert) return new URL(sti, request.url);
  const absolut = adminUrl(sti);
  if (/^https?:\/\//i.test(absolut)) return new URL(absolut);
  const url = new URL(sti, request.url);
  url.hostname = vaert;
  return url;
}

// videre: svaret med de (evt. fornyede) session-cookies. Ved en omdirigering
// eller fejl følger cookies med, så en fornyet session ikke tabes (ellers
// ville næste forespørgsel bruge det gamle refresh-token igen).
function gateSvar(request: NextRequest, b: GateBeslutning, videre?: NextResponse): NextResponse {
  const res = gateSvarUdenCookies(request, b, videre);
  if (videre && res !== videre) {
    for (const c of videre.cookies.getAll()) res.cookies.set(c);
  }
  return res;
}

function gateSvarUdenCookies(request: NextRequest, b: GateBeslutning, videre?: NextResponse): NextResponse {
  switch (b.type) {
    case "videre":
      return videre ?? NextResponse.next();
    case "robots":
      return new NextResponse(ROBOTS_ADMIN, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    case "omdiriger":
      // "admin-vaert": samme sti og søgning på admin-hosten (307 - metoden
      // bevares, men kun GET/HEAD omdirigeres).
      if (b.til === "admin-vaert") {
        return NextResponse.redirect(tilAdminVaert(request, `${request.nextUrl.pathname}${request.nextUrl.search}`), 307);
      }
      return NextResponse.redirect(new URL(b.til, request.url), 307);
    case "status":
      return new NextResponse(b.tekst, { status: b.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

// Proxyen på admin-hosten. Egen, host-only session-cookie (adminCookieOptions)
// - hovedsitets session sendes aldrig hertil. Gaten før lancering, firmakonti
// og beta køres ikke: kun staff kommer længere end /adgang.
export async function adminGate(
  request: NextRequest,
  ekstraHeadere: Record<string, string> = {},
): Promise<NextResponse> {
  const naeste = () => {
    const headers = new Headers(request.headers);
    for (const [k, v] of Object.entries(ekstraHeadere)) headers.set(k, v);
    return NextResponse.next({ request: { headers } });
  };
  let supabaseResponse = naeste();

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
    cookieOptions: adminCookieOptions(),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = naeste();
        cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options));
      },
    },
  });

  const { pathname, search } = request.nextUrl;
  // Ukendte stier, Next' egne filer, ikoner, robots og / afgøres uden
  // session (ingen opslag).
  const rute = adminRute(pathname);
  if (rute !== "admin" && rute !== "adgang") {
    const b = adminGateBeslutning({ pathname, soeg: search, metode: request.method, session: "ingen", rolle: null });
    return gateSvar(request, b, supabaseResponse);
  }

  // Lokal JWT-tjek (getClaims fornyer også en udløbet session).
  const { data, error } = await supabase.auth.getClaims();
  const claims = !error && data?.claims && typeof data.claims.sub === "string" ? data.claims : null;
  const session = adminSessionTilstand(claims, toTrinMaksTimer(), Math.floor(Date.now() / 1000));

  // En admin-cookie uden gyldige claims (forfalsket, udløbet og ikke
  // fornyelig, logget ud andetsteds): ryddes altid, og alt andet end
  // GET/HEAD afvises med 401 - aldrig fail open til "uden session".
  const navn = adminCookieOptions().name;
  const adminCookies = request.cookies.getAll().filter((c) => c.name === navn || c.name.startsWith(`${navn}.`));
  if (!claims && adminCookies.length > 0) {
    const laes = request.method === "GET" || request.method === "HEAD";
    const res = laes
      ? gateSvar(request, adminGateBeslutning({ pathname, soeg: search, metode: request.method, session: "ingen", rolle: null }), supabaseResponse)
      : new NextResponse("Log ind igen", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const o = adminCookieOptions();
    for (const c of adminCookies) res.cookies.set(c.name, "", { path: o.path, secure: o.secure, sameSite: o.sameSite, maxAge: 0 });
    return res;
  }

  let rolle: string | null = null;
  let nyCookie: { vaerdi: string; maxAge: number } | null = null;
  if (claims && adminGateKraeverRolle(pathname, request.method, session)) {
    const id = await hentGateIdentitet(request, supabase, {
      brugerId: claims.sub as string,
      sessionId: typeof claims.session_id === "string" ? claims.session_id : null,
    });
    rolle = id.rolle;
    nyCookie = id.nyCookie;
  }

  const b = adminGateBeslutning({ pathname, soeg: search, metode: request.method, session, rolle });
  return saetRolleCookie(request, gateSvar(request, b, supabaseResponse), nyCookie);
}

export function saetAdminHeadere(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(ADMIN_HEADERE)) res.headers.set(k, v);
  return res;
}
