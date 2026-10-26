// Proxyens regler for admin på egen host (src/lib/supabase/middleware.ts) -
// rene funktioner uden Supabase, så routing-matricen kan enhedstestes
// (tests/enhed/adminGate.test.ts). docs/ADMIN-VAERT.md.
import { andetTrinFrisk } from "@/lib/staffToTrinRegler";
import type { HovedLukning } from "@/lib/adminVaert";

export type AdminRute = "rod" | "robots" | "admin" | "adgang" | "next" | "ikon" | "ukendt";

const IKONER = new Set(["/favicon.ico", "/icon.svg", "/icon1.png", "/apple-icon.png"]);

export function erAdminSti(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

export function erAdgangSti(pathname: string): boolean {
  return pathname === "/adgang" || pathname.startsWith("/adgang/");
}

// Tilladelseslisten på admin-hosten. Alt andet er 404.
// Admin-CSV'erne (/admin/penge/csv, /admin/konkurrence/csv) ligger under /admin.
export function adminRute(pathname: string): AdminRute {
  if (pathname === "/") return "rod";
  if (pathname === "/robots.txt") return "robots";
  if (erAdminSti(pathname)) return "admin";
  if (erAdgangSti(pathname)) return "adgang";
  if (pathname.startsWith("/_next/")) return "next";
  if (IKONER.has(pathname)) return "ikon";
  return "ukendt";
}

// Sessionens tilstand ud fra JWT'en (getClaims).
export type AdminSession = "ingen" | "aal1" | "aal2" | "aal2_gammel";

export function adminSessionTilstand(
  claims: { aal?: unknown; amr?: unknown } | null,
  maksTimer: number,
  nuSek: number,
): AdminSession {
  if (!claims) return "ingen";
  if (claims.aal !== "aal2") return "aal1";
  return andetTrinFrisk(claims.amr, maksTimer * 3600, nuSek) ? "aal2" : "aal2_gammel";
}

const STAFF = new Set(["medarbejder", "admin", "chef", "saelger"]);

export type GateBeslutning =
  | { type: "videre" }
  | { type: "omdiriger"; til: string }
  | { type: "status"; status: 401 | 403 | 404; tekst: string }
  | { type: "robots" };

export const IKKE_FUNDET = { type: "status", status: 404, tekst: "Siden findes ikke" } as const;

function laesning(metode: string) {
  return metode === "GET" || metode === "HEAD";
}

function medNaeste(sti: string, pathname: string, soeg: string): string {
  return `${sti}?naeste=${encodeURIComponent(`${pathname}${soeg}`)}`;
}

// Har beslutningen brug for rollen? (Så slås den kun op, når den skal bruges.)
export function adminGateKraeverRolle(pathname: string, metode: string, session: AdminSession): boolean {
  if (session === "ingen") return false;
  const rute = adminRute(pathname);
  return rute === "admin" || (rute === "adgang" && !laesning(metode));
}

// Hele afgørelsen på admin-hosten. Gaten før lancering, firmakonti og beta
// køres IKKE her - kun staff kommer længere end login-siderne.
//   /            -> /admin
//   /robots.txt  -> "Disallow: /"
//   /_next/*, ikoner: kun GET/HEAD
//   /adgang*     -> login, kode, opsæt, gendan. GET for alle. Andre metoder
//                   kun til route handlerne /adgang/api/* (ingen server
//                   actions - et vilkårligt action-id kan ikke postes hertil
//                   uden om hovedsitets gate før lancering), og kun uden
//                   session eller for staff med aal1/en for gammel kode.
//                   /adgang/api/logud altid.
//   /admin*      -> uden session: login. Ikke staff: 404. aal1 eller en kode
//                   ældre end grænsen: kode-siden. 'saelger' kun Erhverv.
//                   Andre metoder end GET/HEAD får 401/403 i stedet for at
//                   blive sendt videre.
//   alt andet    -> 404.
// Hver admin-side og -action tjekker desuden selv (hentStaffAdgang i
// src/lib/adminAuth.ts) - proxyen er det første værn, ikke det eneste.
export function adminGateBeslutning(i: {
  pathname: string;
  soeg: string;
  metode: string;
  session: AdminSession;
  rolle: string | null;
}): GateBeslutning {
  const rute = adminRute(i.pathname);
  const laes = laesning(i.metode);
  const staff = !!i.rolle && STAFF.has(i.rolle);

  switch (rute) {
    case "ukendt":
      return IKKE_FUNDET;
    case "next":
    case "ikon":
      return laes ? { type: "videre" } : IKKE_FUNDET;
    case "robots":
      return laes ? { type: "robots" } : IKKE_FUNDET;
    case "rod":
      return laes ? { type: "omdiriger", til: "/admin" } : IKKE_FUNDET;
    case "adgang":
      if (laes) return { type: "videre" };
      // Kun route handlerne under /adgang/api/* (de kan ikke køre server
      // actions) - et action-id postet til en login-side afvises.
      if (!i.pathname.startsWith("/adgang/api/")) return IKKE_FUNDET;
      // Log ud må altid.
      if (i.pathname === "/adgang/api/logud" || i.pathname === "/adgang/api/logud/") return { type: "videre" };
      // Uden session (login, gendan) eller staff, der mangler to-trins-login
      // eller en ny kode. Fuldt inde (frisk aal2) har man intet at gøre her.
      if (i.session === "ingen") return { type: "videre" };
      if (staff && (i.session === "aal1" || i.session === "aal2_gammel")) return { type: "videre" };
      return { type: "status", status: 403, tekst: "Ingen adgang" };
    case "admin": {
      if (i.session === "ingen") {
        return laes
          ? { type: "omdiriger", til: medNaeste("/adgang/login", i.pathname, i.soeg) }
          : { type: "status", status: 401, tekst: "Log ind først" };
      }
      if (!staff) return IKKE_FUNDET;
      if (i.session !== "aal2") {
        return laes
          ? { type: "omdiriger", til: medNaeste("/adgang/kode", i.pathname, i.soeg) }
          : { type: "status", status: 401, tekst: "Kræver to-trins-login" };
      }
      const erhverv = i.pathname === "/admin/erhverv" || i.pathname.startsWith("/admin/erhverv/");
      if (i.rolle === "saelger" && !erhverv) {
        return laes ? { type: "omdiriger", til: "/admin/erhverv" } : { type: "status", status: 403, tekst: "Ingen adgang" };
      }
      return { type: "videre" };
    }
  }
}

// bidhamr.dk (hovedhosten) med ADMIN_VAERT sat. null = gaten fortsætter som før.
//   /adgang*: findes kun på admin-hosten -> 404 (også uden ADMIN_VAERT).
//   /admin*:  ADMIN_LUK_HOVEDDOMAENE ikke sat: som i dag (siderne sender
//             selv videre til admin-hosten, og admin-actions afviser alt
//             uden for admin-hosten - src/lib/adminAuth.ts).
//             "omdiriger": GET/HEAD -> 307 til admin-hosten, alt andet 404.
//             "1": alt 404.
export function hovedAdminBeslutning(pathname: string, metode: string, luk: HovedLukning): GateBeslutning | null {
  if (erAdgangSti(pathname)) return IKKE_FUNDET;
  if (!erAdminSti(pathname) || luk === "nej") return null;
  if (luk === "omdiriger" && laesning(metode)) return { type: "omdiriger", til: "admin-vaert" };
  return IKKE_FUNDET;
}

export const ROBOTS_ADMIN = "User-agent: *\nDisallow: /\n";

// Headere på alle svar fra admin-hosten.
export const ADMIN_HEADERE: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
};
