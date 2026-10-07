import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { sikkerSti } from "@/lib/sikkerSti";
import { registrerLogin } from "@/lib/enheder";
import { TJEK_EMAIL_COOKIE } from "@/lib/tilmelding";
import { hentKontoStatus } from "@/lib/kontoStatus";
import { erLinkType } from "@/lib/authLink";

// Fælles landingspunkt for Supabase auth-links (nulstilling af adgangskode,
// velkomstlinks til firmakonti, ældre bekræftelseslinks, magic links).
// Supabase sender brugeren hertil med enten ?code= (PKCE) eller
// ?token_hash=&type= afhængigt af flow. Ved oprettelse bruges i dag en
// 6-cifret kode i mailen (supabase/templates/confirmation.html), som
// indtastes på /tjek-indbakke (verificerSignupKode i src/app/actions/auth.ts).
//
// MAIL-SCANNERE: Microsoft Safe Links og lignende åbner (GET) alle links i en
// mail, før modtageren gør. Et engangslink med ?token_hash= ville så være
// brugt, når brugeren selv trykker. Derfor indløser GET ALDRIG et token_hash:
// brugeren sendes til mellemsiden /bekraeft (én stor knap), og først knappen
// (POST hertil) indløser det. ?code= (PKCE) indløses stadig med det samme:
// koden kan kun bruges i den browser, der startede flowet (code verifier i en
// cookie), så en scanner kan ikke bruge den - og OAuth-udbydere (hvis de
// kommer) skal heller ikke have en mellemside.
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
// Velkomstlinks til firmakonti (type=invite, eller recovery med
// next=/reset-password?velkommen=1 for en eksisterende auth-bruger) kan
// firmaet ikke selv få et nyt af - det sender BidHamr. De sendes derfor til
// login med koden velkommen_udloebet ("Skriv til erhverv@bidhamr.dk ...").
function tilFejl(origin: string, kode: FejlKode, erBekraeftelse: boolean, erVelkomst = false) {
  if (erVelkomst && kode !== "konto_suspenderet") {
    const url = new URL("/login", origin);
    url.searchParams.set("fejl", "velkommen_udloebet");
    return NextResponse.redirect(url, 303);
  }
  const url = new URL(erBekraeftelse ? "/tjek-indbakke" : "/login", origin);
  url.searchParams.set("fejl", kode);
  return NextResponse.redirect(url, 303);
}

function erVelkomstLink(type: string | null, naeste: string | null) {
  return type === "invite" || (!!naeste && naeste.startsWith("/reset-password?velkommen=1"));
}

const BEKRAEFTELSE_TYPER = new Set(["signup", "email", "invite"]);

function erUdloebet(kode: string | null | undefined) {
  return !!kode && (kode.includes("expired") || kode === "otp_expired");
}

type LinkParametre = {
  code: string | null;
  tokenHash: string | null;
  type: EmailOtpType | null;
  naeste: string | null;
};

function maalFor(p: LinkParametre) {
  const erBekraeftelse = (p.type !== null && BEKRAEFTELSE_TYPER.has(p.type)) || p.naeste === "/velkommen";
  // Recovery-links skal ende på formularen til ny adgangskode.
  const standardMaal = p.type === "recovery" ? "/reset-password" : erBekraeftelse ? "/velkommen" : "/auktioner";
  return { erBekraeftelse, maal: sikkerSti(p.naeste, standardMaal) };
}

// Indløser koden/tokenet og logger brugeren ind. Fælles for GET (?code=) og
// POST (knappen på /bekraeft).
async function indloes(origin: string, p: LinkParametre) {
  const { erBekraeftelse, maal } = maalFor(p);
  const supabase = await createClient();

  let svar: Awaited<ReturnType<typeof supabase.auth.verifyOtp>> | null = null;
  if (p.code) {
    svar = await supabase.auth.exchangeCodeForSession(p.code);
  } else if (p.tokenHash && p.type) {
    svar = await supabase.auth.verifyOtp({ token_hash: p.tokenHash, type: p.type });
  }

  if (!svar) {
    // Ingen parametre på serveren: tokenet ligger sandsynligvis i hash-fragmentet.
    // Målsiden er en klientkomponent og kan selv læse det.
    return NextResponse.redirect(new URL(maal, origin), 303);
  }

  if (svar.error) {
    console.error("auth/callback fejlede:", svar.error.code, svar.error.message);
    return tilFejl(
      origin,
      erUdloebet(svar.error.code) ? "link_udloebet" : "link_ugyldigt",
      erBekraeftelse,
      erVelkomstLink(p.type, p.naeste),
    );
  }

  const { user, session } = svar.data;
  if (erBekraeftelse) (await cookies()).delete(TJEK_EMAIL_COOKIE);

  // Nulstilling af adgangskode: med token_hash kommer type=recovery; med
  // ?code= (PKCE) kendes det kun på målet (/reset-password). En nulstilling
  // er ikke et nyt login - ingen registrering af enheden og ingen mail.
  // Alle andre links (fx ?token_hash= med next=/reset-password) behandles
  // som et almindeligt login.
  const erNulstilling =
    p.type === "recovery" ||
    (p.code !== null && (maal === "/reset-password" || maal.startsWith("/reset-password?")));

  // Samme tjek som ved almindeligt login: slettede og suspenderede konti
  // lukkes ikke ind (fail closed, hvis profilen ikke kan læses).
  if (user) {
    const status = await hentKontoStatus(user.id);
    if (status.kode !== "ok") {
      await supabase.auth.signOut({ scope: "local" });
      return tilFejl(origin, status.kode === "suspenderet" ? "konto_suspenderet" : "link_ugyldigt", false);
    }
  }

  // Enheden registreres (første login efter oprettelse giver ingen mail).
  if (user && session && !erNulstilling) {
    await registrerLogin({ brugerId: user.id, email: user.email, accessToken: session.access_token });
  }

  return NextResponse.redirect(new URL(maal, origin), 303);
}

export async function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl;

  const p: LinkParametre = {
    code: searchParams.get("code"),
    tokenHash: searchParams.get("token_hash"),
    type: searchParams.get("type") as EmailOtpType | null,
    naeste: searchParams.get("next"),
  };
  const fejlKode = searchParams.get("error_code") ?? searchParams.get("error");

  // Supabase kan selv melde fejl tilbage, fx hvis linket er udløbet.
  if (fejlKode) {
    const { erBekraeftelse } = maalFor(p);
    return tilFejl(
      origin,
      erUdloebet(fejlKode) ? "link_udloebet" : "link_ugyldigt",
      erBekraeftelse,
      erVelkomstLink(p.type, p.naeste),
    );
  }

  // Engangslink fra en mail: vis mellemsiden - indløs IKKE her (se øverst).
  if (!p.code && p.tokenHash) {
    const url = new URL("/bekraeft", origin);
    url.searchParams.set("token_hash", p.tokenHash);
    if (p.type) url.searchParams.set("type", p.type);
    const { maal } = maalFor(p);
    url.searchParams.set("next", maal);
    return NextResponse.redirect(url, 303);
  }

  return indloes(origin, p);
}

// Knappen på /bekraeft. Kun fra vores egen side (Origin/Sec-Fetch-Site), så
// et fremmed site ikke kan logge en besøgende ind på en anden konto
// (login-CSRF) ved at poste et token hertil.
export async function POST(req: NextRequest) {
  const { origin } = req.nextUrl;
  const afsender = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  const egenSide = fetchSite ? fetchSite === "same-origin" : afsender === origin;
  if (!egenSide) {
    return tilFejl(origin, "link_ugyldigt", false);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return tilFejl(origin, "link_ugyldigt", false);
  }
  const tekst = (navn: string) => {
    const v = form.get(navn);
    return typeof v === "string" && v.length > 0 && v.length <= 2000 ? v : null;
  };
  const tokenHash = tekst("token_hash");
  const type = tekst("type");
  if (!tokenHash || !erLinkType(type)) {
    return tilFejl(
      origin,
      "link_ugyldigt",
      type !== null && BEKRAEFTELSE_TYPER.has(type),
      erVelkomstLink(type, tekst("next")),
    );
  }
  return indloes(origin, { code: null, tokenHash, type, naeste: tekst("next") });
}
