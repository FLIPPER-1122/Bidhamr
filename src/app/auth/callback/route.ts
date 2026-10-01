import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { sikkerSti } from "@/lib/sikkerSti";

// Fælles landingspunkt for Supabase auth-links (nulstilling af adgangskode,
// e-mailbekræftelse, magic links). Supabase sender brugeren hertil med enten
// ?code= (PKCE) eller ?token_hash=&type= afhængigt af flow.
//
// BEMÆRK: kommer tokenet som hash-fragment (#access_token=...), når det aldrig
// serveren - browseren sender ikke fragmenter med. I det tilfælde sendes
// brugeren videre til målsiden, hvor Supabase-klienten selv læser fragmentet.

// Kun interne stier accepteres som mål, så ?next= ikke kan bruges til at
// videresende brugeren til et fremmed domæne (open redirect). Se src/lib/sikkerSti.ts.

// Fejl sendes videre som en fast kode - aldrig Supabase' egen fejltekst, som
// kan indeholde interne detaljer. Login-siden oversaetter koden til dansk.
function tilLogin(origin: string, kode: "link_udloebet" | "link_ugyldigt") {
  const url = new URL("/login", origin);
  url.searchParams.set("fejl", kode);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const fejlKode = searchParams.get("error_code") ?? searchParams.get("error");

  // Supabase kan selv melde fejl tilbage, fx hvis linket er udløbet.
  if (fejlKode) {
    return tilLogin(origin, fejlKode.includes("expired") ? "link_udloebet" : "link_ugyldigt");
  }

  // Recovery-links skal ende på formularen til ny adgangskode.
  const standardMaal = type === "recovery" ? "/reset-password" : "/auktioner";
  const maal = sikkerSti(searchParams.get("next"), standardMaal);

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error("auth/callback fejlede:", error.message);
      return tilLogin(origin, "link_ugyldigt");
    }
    return NextResponse.redirect(new URL(maal, origin));
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) {
      console.error("auth/callback fejlede:", error.message);
      return tilLogin(origin, "link_ugyldigt");
    }
    return NextResponse.redirect(new URL(maal, origin));
  }

  // Ingen parametre på serveren: tokenet ligger sandsynligvis i hash-fragmentet.
  // Målsiden er en klientkomponent og kan selv læse det.
  return NextResponse.redirect(new URL(maal, origin));
}
