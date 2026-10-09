import "server-only";

import { NextResponse } from "next/server";
import { sikkerSti } from "@/lib/sikkerSti";
import type { MitIdResultat } from "@/lib/tekster/mitid";

// Fælles for /api/mitid/start, /api/mitid/callback og /api/mitid/app.

// Cookien binder login-forløbet til browseren (mod login-CSRF): state ligger
// i cookien og skal være den samme, når Idura sender brugeren tilbage.
export const MITID_COOKIE = "bh_mitid";
export const MITID_COOKIE_STI = "/api/mitid";
export const FLOW_LEVETID_SEK = 10 * 60;
// Appens engangs-token skal indløses inden for 2 minutter.
export const APP_TOKEN_LEVETID_SEK = 2 * 60;

export const STANDARD_RETUR = "/konto";

// Kun interne sider - aldrig en API-sti (ingen løkker) og højst 500 tegn.
export function renRetur(raa: string | null | undefined): string {
  const sti = sikkerSti(raa ?? null, STANDARD_RETUR);
  if (sti.length > 500 || sti.startsWith("/api/") || sti === "/api") return STANDARD_RETUR;
  return sti;
}

// Appens deep link (fx bidhamr://mitid). Kan sættes med MITID_APP_RETUR,
// men kun til et eget app-skema - aldrig http(s), så det ikke kan bruges til
// at sende brugeren til en fremmed hjemmeside.
export function appRetur(): string {
  const v = (process.env.MITID_APP_RETUR ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\/[a-z0-9/_-]*$/i.test(v) && !/^https?:/i.test(v)) return v;
  return "bidhamr://mitid";
}

export function tilSide(origin: string, retur: string, resultat: MitIdResultat): NextResponse {
  const u = new URL(renRetur(retur), origin);
  u.searchParams.set("mitid", resultat);
  return udenCookie(NextResponse.redirect(u, 303));
}

export function tilApp(resultat: MitIdResultat): NextResponse {
  const u = new URL(appRetur());
  u.searchParams.set("status", resultat);
  return udenCookie(NextResponse.redirect(u.toString(), 303));
}

// Appen: MitID er gennemført - appen afslutter selv med sit engangs-id
// (POST /api/mitid/app/afslut med Bearer-session og app-hemmelighed).
export function tilAppAfslut(k: string): NextResponse {
  const u = new URL(appRetur());
  u.searchParams.set("k", k);
  return udenCookie(NextResponse.redirect(u.toString(), 303));
}

// Hvor længe appen har til at afslutte efter MitID.
export const APP_AFSLUT_LEVETID_SEK = 5 * 60;

export function udenCookie(res: NextResponse): NextResponse {
  res.cookies.set(MITID_COOKIE, "", { path: MITID_COOKIE_STI, maxAge: 0, httpOnly: true, sameSite: "lax" });
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

// Svar fra mitid_registrer -> resultat til brugeren.
export function resultatFraKode(kode: string | undefined): MitIdResultat {
  switch (kode) {
    case "ok":
      return "ok";
    case "allerede":
      return "allerede";
    case "dobbeltkonto":
      return "dobbeltkonto";
    case "under_18":
      return "under18";
    case "lukket_konto":
    case "lukket_konto_mitid":
      return "lukket";
    case "tidligere_spaerret":
      return "tidligereSpaerret";
    case "anden_mitid":
      return "andenMitid";
    case "erhverv":
      return "erhverv";
    default:
      return "fejl";
  }
}
