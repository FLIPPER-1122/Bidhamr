import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { EmailOtpType } from "@supabase/supabase-js";

// Fælles landingspunkt for Supabase auth-links (nulstilling af adgangskode,
// e-mailbekræftelse, magic links). Supabase sender brugeren hertil med enten
// ?code= (PKCE) eller ?token_hash=&type= afhængigt af flow.
//
// BEMÆRK: kommer tokenet som hash-fragment (#access_token=...), når det aldrig
// serveren - browseren sender ikke fragmenter med. I det tilfælde sendes
// brugeren videre til målsiden, hvor Supabase-klienten selv læser fragmentet.

// Kun interne stier accepteres som mål, så ?next= ikke kan bruges til at
// videresende brugeren til et fremmed domæne (open redirect).
function sikkerSti(next: string | null, fallback: string) {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return fallback;
  return next;
}

export async function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const fejlBeskrivelse =
    searchParams.get("error_description") ?? searchParams.get("error");

  // Supabase kan selv melde fejl tilbage, fx hvis linket er udløbet.
  if (fejlBeskrivelse) {
    const url = new URL("/login", origin);
    url.searchParams.set("fejl", fejlBeskrivelse);
    return NextResponse.redirect(url);
  }

  // Recovery-links skal ende på formularen til ny adgangskode.
  const standardMaal = type === "recovery" ? "/reset-password" : "/auktioner";
  const maal = sikkerSti(searchParams.get("next"), standardMaal);

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const url = new URL("/login", origin);
      url.searchParams.set("fejl", error.message);
      return NextResponse.redirect(url);
    }
    return NextResponse.redirect(new URL(maal, origin));
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) {
      const url = new URL("/login", origin);
      url.searchParams.set("fejl", error.message);
      return NextResponse.redirect(url);
    }
    return NextResponse.redirect(new URL(maal, origin));
  }

  // Ingen parametre på serveren: tokenet ligger sandsynligvis i hash-fragmentet.
  // Målsiden er en klientkomponent og kan selv læse det.
  return NextResponse.redirect(new URL(maal, origin));
}
