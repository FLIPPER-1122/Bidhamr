import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { sikkerSti } from "@/lib/sikkerSti";
import { registrerLogin } from "@/lib/enheder";
import { harToTrin, TO_TRIN_STI } from "@/lib/mfa";
import { TJEK_EMAIL_COOKIE } from "@/lib/tilmelding";
import { hentKontoStatus } from "@/lib/kontoStatus";

// Fælles landingspunkt for Supabase auth-links (nulstilling af adgangskode,
// e-mailbekræftelse, magic links). Supabase sender brugeren hertil med enten
// ?code= (PKCE) eller ?token_hash=&type= afhængigt af flow. Bekræftelses-
// mailen (supabase/templates/confirmation.html) bruger token_hash, så linket
// også virker, når det åbnes i en anden browser end den, kontoen blev
// oprettet i.
//
// BEMÆRK: kommer tokenet som hash-fragment (#access_token=...), når det aldrig
// serveren - browseren sender ikke fragmenter med. I det tilfælde sendes
// brugeren videre til målsiden, hvor Supabase-klienten selv læser fragmentet.

// Kun interne stier accepteres som mål, så ?next= ikke kan bruges til at
// videresende brugeren til et fremmed domæne (open redirect). Se src/lib/sikkerSti.ts.

type FejlKode = "link_udloebet" | "link_ugyldigt" | "konto_suspenderet";

// Fejl sendes videre som en fast kode - aldrig Supabase' egen fejltekst, som
// kan indeholde interne detaljer. Bekræftelseslinks sendes til "Tjek din
// indbakke", hvor man kan få en ny mail; andre links til login-siden.
function tilFejl(origin: string, kode: FejlKode, erBekraeftelse: boolean) {
  const url = new URL(erBekraeftelse ? "/tjek-indbakke" : "/login", origin);
  url.searchParams.set("fejl", kode);
  return NextResponse.redirect(url);
}

const BEKRAEFTELSE_TYPER = new Set(["signup", "email", "invite"]);

function erUdloebet(kode: string | null | undefined) {
  return !!kode && (kode.includes("expired") || kode === "otp_expired");
}

export async function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const fejlKode = searchParams.get("error_code") ?? searchParams.get("error");
  const naeste = searchParams.get("next");
  const erBekraeftelse =
    (type !== null && BEKRAEFTELSE_TYPER.has(type)) || naeste === "/velkommen";

  // Supabase kan selv melde fejl tilbage, fx hvis linket er udløbet.
  if (fejlKode) {
    return tilFejl(origin, erUdloebet(fejlKode) ? "link_udloebet" : "link_ugyldigt", erBekraeftelse);
  }

  // Recovery-links skal ende på formularen til ny adgangskode.
  const standardMaal = type === "recovery" ? "/reset-password" : erBekraeftelse ? "/velkommen" : "/auktioner";
  const maal = sikkerSti(naeste, standardMaal);

  const supabase = await createClient();

  let svar: Awaited<ReturnType<typeof supabase.auth.verifyOtp>> | null = null;
  if (code) {
    svar = await supabase.auth.exchangeCodeForSession(code);
  } else if (tokenHash && type) {
    svar = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  }

  if (!svar) {
    // Ingen parametre på serveren: tokenet ligger sandsynligvis i hash-fragmentet.
    // Målsiden er en klientkomponent og kan selv læse det.
    return NextResponse.redirect(new URL(maal, origin));
  }

  if (svar.error) {
    console.error("auth/callback fejlede:", svar.error.code, svar.error.message);
    return tilFejl(origin, erUdloebet(svar.error.code) ? "link_udloebet" : "link_ugyldigt", erBekraeftelse);
  }

  const { user, session } = svar.data;
  if (erBekraeftelse) (await cookies()).delete(TJEK_EMAIL_COOKIE);

  // Nulstilling af adgangskode: med token_hash kommer type=recovery; med
  // ?code= (PKCE) kendes det kun på målet (/reset-password). En nulstilling
  // er ikke et nyt login - ingen registrering af enheden og ingen mail.
  // Alle andre links (fx ?token_hash= med next=/reset-password) behandles
  // som et almindeligt login.
  const erNulstilling =
    type === "recovery" ||
    (code !== null && (maal === "/reset-password" || maal.startsWith("/reset-password?")));

  // Samme tjek som ved almindeligt login: slettede og suspenderede konti
  // lukkes ikke ind (fail closed, hvis profilen ikke kan læses).
  if (user) {
    const status = await hentKontoStatus(user.id);
    if (status.kode !== "ok") {
      await supabase.auth.signOut({ scope: "local" });
      return tilFejl(origin, status.kode === "suspenderet" ? "konto_suspenderet" : "link_ugyldigt", false);
    }
  }

  // Linket logger brugeren ind. Har brugeren to-trins-login, skal koden
  // indtastes først (gælder ikke nulstilling - den side beder selv om koden).
  if (user && !erNulstilling && harToTrin(user)) {
    const url = new URL(TO_TRIN_STI, origin);
    url.searchParams.set("redirect", maal);
    return NextResponse.redirect(url);
  }

  // Enheden registreres (første login efter oprettelse giver ingen mail).
  if (user && session && !erNulstilling) {
    await registrerLogin({ brugerId: user.id, email: user.email, accessToken: session.access_token });
  }

  return NextResponse.redirect(new URL(maal, origin));
}
