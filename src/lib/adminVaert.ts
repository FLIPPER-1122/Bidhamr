// Admin på egen adresse (admin.bidhamr.dk) - Filip, 19. okt. 2026
// (ROADMAP-BESLUTNINGER.md, "Admin på admin.bidhamr.dk"; docs/ADMIN-VAERT.md).
//
// Samme Vercel-projekt, host-baseret routing. Styres af miljøet:
//   ADMIN_VAERT              fx "admin.bidhamr.dk". Ikke sat = flaget er slået
//                            fra, og alt virker som før (ingen to-trins-krav).
//   NEXT_PUBLIC_ADMIN_URL    fx "https://admin.bidhamr.dk" - links og mails til
//                            admin. Skal sættes sammen med ADMIN_VAERT.
//   ADMIN_LUK_HOVEDDOMAENE   bidhamr.dk/admin: ikke sat = som i dag,
//                            "omdiriger" = GET 307 til admin-hosten og alt
//                            andet 404, "1" = alt 404.
//
// Ingen server-only-import: filen bruges af proxyen, server-kode OG browseren
// (cookienavnet i browser-klienten og links i menuerne). ADMIN_VAERT og
// ADMIN_LUK_HOVEDDOMAENE er kun kendt på serveren; i browseren er de
// undefined, og funktionerne svarer "slået fra".

// Hostnavn uden port, små bogstaver og uden afsluttende punktum. IPv6 i
// [klammer] beholdes uden port. Tom eller ugyldig værdi giver "".
export function normaliserVaert(vaert: string | null | undefined): string {
  if (typeof vaert !== "string") return "";
  let v = vaert.trim().toLowerCase();
  if (!v) return "";
  // Kun den første værdi, hvis nogen har sat en liste.
  v = v.split(",")[0].trim();
  if (v.startsWith("[")) {
    const slut = v.indexOf("]");
    return slut > 0 ? v.slice(0, slut + 1) : "";
  }
  const kolon = v.indexOf(":");
  if (kolon >= 0) v = v.slice(0, kolon);
  v = v.replace(/\.$/, "");
  // Kun tegn, et hostnavn kan have.
  return /^[a-z0-9.-]+$/.test(v) ? v : "";
}

function erProduktion(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

// Den konfigurerede admin-host, eller null (flaget slået fra). En
// *.vercel.app-adresse godtages aldrig i produktion: den kan ikke beskyttes af
// firewall-reglen for admin.bidhamr.dk, og preview-adresser deles med andre.
export function adminVaertKonfig(): string | null {
  const v = normaliserVaert(process.env.ADMIN_VAERT);
  if (!v) return null;
  return v;
}

// Er admin-hosten slået til (ADMIN_VAERT sat)? Kun meningsfuldt på serveren.
export function adminVaertAktiv(): boolean {
  return adminVaertKonfig() !== null;
}

// Er forespørgslens host admin-hosten? Præcis sammenligning af `Host`-headeren
// (uden port, små bogstaver). x-forwarded-host ignoreres med vilje: den kan
// sættes af klienten, og Vercel router alligevel på Host. Aldrig *.vercel.app
// i produktion - heller ikke hvis ADMIN_VAERT ved en fejl peger på en.
export function erAdminVaert(host: string | null | undefined): boolean {
  const konfig = adminVaertKonfig();
  if (!konfig) return false;
  const v = normaliserVaert(host);
  if (!v || v !== konfig) return false;
  if (erProduktion() && v.endsWith(".vercel.app")) return false;
  return true;
}

export type HovedLukning = "nej" | "omdiriger" | "luk";

// Hvad bidhamr.dk/admin skal gøre. Kun aktiv, når ADMIN_VAERT er sat - uden
// admin-host er der intet at sende videre til.
export function hovedDomaeneLukning(): HovedLukning {
  if (!adminVaertAktiv()) return "nej";
  const v = (process.env.ADMIN_LUK_HOVEDDOMAENE ?? "").trim().toLowerCase();
  if (v === "1" || v === "true" || v === "luk") return "luk";
  if (v === "omdiriger") return "omdiriger";
  return "nej";
}

function udenSkraastreg(url: string): string {
  return url.replace(/\/+$/, "");
}

function adminBase(): string | null {
  const url = process.env.NEXT_PUBLIC_ADMIN_URL;
  if (!url || !/^https?:\/\/[^/]+/i.test(url)) return null;
  return udenSkraastreg(url);
}

function siteBase(): string {
  return udenSkraastreg(process.env.NEXT_PUBLIC_SITE_URL || "https://bidhamr.dk");
}

// Link til en side i admin, fx adminUrl("/admin/sager/<id>"). Med
// NEXT_PUBLIC_ADMIN_URL: fuld adresse på admin-hosten. Uden: den relative sti
// (som før - admin ligger på samme host).
export function adminUrl(sti: string): string {
  const base = adminBase();
  const s = sti.startsWith("/") ? sti : `/${sti}`;
  return base ? `${base}${s}` : s;
}

// Til mails: altid en fuld adresse (admin-hosten, ellers hovedsitet).
export function adminAbsolutUrl(sti: string): string {
  const s = sti.startsWith("/") ? sti : `/${sti}`;
  return `${adminBase() ?? siteBase()}${s}`;
}

// Link fra admin til en side på hovedsitet (fx /auktion/<id>). Er admin på sin
// egen host (NEXT_PUBLIC_ADMIN_URL sat), skal linket have hovedsitets fulde
// adresse - admin-hosten svarer 404 på alt andet end admin. Ellers relativ.
export function hovedsiteUrl(sti: string): string {
  const s = sti.startsWith("/") ? sti : `/${sti}`;
  return adminBase() ? `${siteBase()}${s}` : s;
}

// Admin-hostens hostnavn ud fra NEXT_PUBLIC_ADMIN_URL (til browseren).
export function adminVaertFraUrl(): string | null {
  const base = adminBase();
  if (!base) return null;
  try {
    return normaliserVaert(new URL(base).host) || null;
  } catch {
    return null;
  }
}

// Opstartstjek (src/instrumentation.ts): ADMIN_VAERT og NEXT_PUBLIC_ADMIN_URL
// skal sættes sammen og pege på samme host (https i produktion). Ellers
// sender links og mails staff et forkert sted hen. null = i orden.
export function adminKonfigFejl(): string | null {
  const raaVaert = (process.env.ADMIN_VAERT ?? "").trim();
  const raaUrl = (process.env.NEXT_PUBLIC_ADMIN_URL ?? "").trim();
  if (!raaVaert && !raaUrl) return null;
  if (raaVaert && !adminVaertKonfig()) return `ADMIN_VAERT er ugyldig ("${raaVaert.slice(0, 80)}")`;
  if (!raaVaert) return "NEXT_PUBLIC_ADMIN_URL er sat, men ADMIN_VAERT mangler - links og mails peger på en admin-host, der ikke er slået til";
  if (!raaUrl) return "ADMIN_VAERT er sat, men NEXT_PUBLIC_ADMIN_URL mangler - links og mails til admin peger på hovedsitet";
  const urlVaert = adminVaertFraUrl();
  if (!urlVaert) return "NEXT_PUBLIC_ADMIN_URL er ugyldig (skal være fx https://admin.bidhamr.dk)";
  if (urlVaert !== adminVaertKonfig()) return `NEXT_PUBLIC_ADMIN_URL (${urlVaert}) passer ikke til ADMIN_VAERT (${adminVaertKonfig()})`;
  if (erProduktion() && !raaUrl.toLowerCase().startsWith("https://")) return "NEXT_PUBLIC_ADMIN_URL skal være https i produktion";
  if (erProduktion() && urlVaert.endsWith(".vercel.app")) return "ADMIN_VAERT må ikke være en *.vercel.app-adresse i produktion";
  return null;
}

// Serveren fortæller browseren, at siden er på admin-hosten, med et
// <meta name="bh-admin-cookie"> i root-layoutet (src/app/layout.tsx). Så
// vælger browser-klienten samme cookie som serveren - uafhængigt af
// NEXT_PUBLIC_ADMIN_URL.
export const ADMIN_COOKIE_META = "bh-admin-cookie";

// I browseren: er siden åbnet på admin-hosten (ifølge serveren)? Bruges KUN
// til at vælge cookienavn i browser-klienten - aldrig til adgang.
export function erAdminVaertKlient(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.querySelector(`meta[name="${ADMIN_COOKIE_META}"]`);
}

// --- Cookie --------------------------------------------------------------
// Admin-sessionen er sin egen, host-only session (ingen Domain-attribut), så
// den aldrig sendes til bidhamr.dk, og hovedsitets session aldrig sendes til
// admin-hosten. I produktion med __Host--præfiks: browseren afviser cookien,
// medmindre den er Secure, har Path=/ og ingen Domain.

export const ADMIN_COOKIE_PROD = "__Host-bh-admin-auth";
export const ADMIN_COOKIE_LOKAL = "bh-admin-auth";

// Levetid i browseren. Sessionen fornyes ved brug; en ny kode kræves
// alligevel efter STAFF_TO_TRIN_MAKS_TIMER (standard 12 timer).
const ADMIN_COOKIE_MAKS_ALDER = 14 * 24 * 60 * 60;

// produktion: true i produktion (https). Lokalt over http kan browseren ikke
// gemme en Secure-cookie på alle hosts, så navnet er uden præfiks.
export function adminCookieNavn(produktion: boolean = process.env.NODE_ENV === "production"): string {
  return produktion ? ADMIN_COOKIE_PROD : ADMIN_COOKIE_LOKAL;
}

export type AdminCookieOptions = {
  name: string;
  path: "/";
  sameSite: "lax";
  secure: boolean;
  maxAge: number;
};

export function adminCookieOptions(produktion: boolean = process.env.NODE_ENV === "production"): AdminCookieOptions {
  return {
    name: adminCookieNavn(produktion),
    path: "/",
    sameSite: "lax",
    secure: produktion,
    maxAge: ADMIN_COOKIE_MAKS_ALDER,
  };
}

// cookieOptions til Supabase-klienten: admin-cookien på admin-hosten, ellers
// Supabases standard (undefined) - så hovedsitet er helt uændret.
export function supabaseCookieOptions(paaAdminVaert: boolean): AdminCookieOptions | undefined {
  return paaAdminVaert ? adminCookieOptions() : undefined;
}
