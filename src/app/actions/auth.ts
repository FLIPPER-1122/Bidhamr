"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  FOR_MANGE_FORSOEG,
  PROEV_IGEN_OM_LIDT,
  graenseFejl,
  klientIp,
  nulstilGraense,
  tjekGraenser,
  tjekGraenserLukket,
} from "@/lib/rateLimit";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { adgangskodeAendretMail } from "@/lib/mails/konto";
import { vurderAdgangskode } from "@/lib/adgangskode";
import { registrerLogin } from "@/lib/enheder";
import { TJEK_EMAIL_COOKIE, tilmeldingAaben } from "@/lib/tilmelding";
import { logDriftFejl } from "@/lib/drift";
import { saetAdgangskodeEfterMaillink, sendNulstillingsmail } from "@/lib/adgangskodeSkift";
import { CAPTCHA_FEJL, erCaptchaFejl, renCaptchaToken } from "@/lib/turnstile";
import { tjekTurnstile } from "@/lib/turnstileServer";
import { hentKontoStatus } from "@/lib/kontoStatus";
import { VILKAAR_VERSION } from "@/lib/vilkaar";
import {
  bekraeftKode,
  opretKontoPaaServeren,
  renEmail,
  renKode,
  renNavn,
  sendNyKodePaaServeren,
} from "@/lib/kontoOprettelse";
import {
  gemVentendeAdgangskode,
  harVentendeAdgangskode,
  hentVentendeAdgangskode,
  sletVentendeAdgangskode,
} from "@/lib/ventendeAdgangskode";

// Login, oprettelse, bekraeftelseskode (e-mail), gensend kode og nulstil
// adgangskode koeres paa serveren, saa de kan rate-limites pr. IP og pr.
// e-mail, og saa kravene til adgangskoden ikke kan omgaas fra browseren.
// Fejl RETURNERES (Next.js skjuler kastede fejl i produktion).
//
// BEMAERK: auth-API'et kan stadig kaldes direkte med anon-noeglen (login,
// nulstilling). Supabase Auths egne rate limits og adgangskodekrav
// (dashboard -> Auth) er vaernet dér. Nye konti kan IKKE oprettes direkte:
// "Allow new users to sign up" er slaaet fra, og databasen kraever en billet
// fra serveren (src/lib/kontoOprettelse.ts).

// firma: true = firmakonto (logInd) - login-siden sender så til /firma.
// vaelgAdgangskode: efter bekræftelse skal brugeren vælge en adgangskode og
// skrive sit navn (/reset-password?fra=signup) - se verificerSignupKode.
// bekraeftNavn: adgangskoden er sat, men navnet kunne ikke gemmes
// (/velkommen?navn=1).
type Resultat =
  | { ok: true; firma?: boolean; vaelgAdgangskode?: true; bekraeftNavn?: true }
  | { fejl: string; kode?: "email_ikke_bekraeftet" | "forkert_login" };

const GENERISK = "Noget gik galt. Prøv igen om lidt.";

// E-mailen fra signup (eller et login med ubekraeftet e-mail) huskes i en
// kort, httpOnly cookie til /tjek-indbakke - den skal ikke staa i URL'en.
async function saetTjekEmailCookie(email: string) {
  (await cookies()).set(TJEK_EMAIL_COOKIE, email, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
}

// Faelles efter et gennemfoert login:
// suspenderede konti logges ud igen med besked om aarsagen, og enheden
// registreres (mail ved ny enhed).
async function efterLogin(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bruger: { id: string; email?: string | null },
  accessToken: string | null | undefined,
): Promise<Resultat> {
  const status = await hentKontoStatus(bruger.id);
  if (status.kode !== "ok") {
    await supabase.auth.signOut({ scope: "local" });
    // Kan profilen ikke laeses, lukkes der ikke ind (fail closed).
    if (status.kode === "fejl") return { fejl: GENERISK };
    if (status.kode === "slettet") return { fejl: "Forkert e-mail eller adgangskode.", kode: "forkert_login" };
    return { fejl: status.besked };
  }

  await registrerLogin({ brugerId: bruger.id, email: bruger.email, accessToken });
  return { ok: true };
}

// Firmakonto (users.konto_type = 'erhverv')? Så lander login på /firma i
// stedet for /auktioner. Kun til at vælge siden - ingen adgang afhænger af det.
async function erFirmakonto(supabase: Awaited<ReturnType<typeof createClient>>, brugerId: string) {
  const { data } = await supabase
    .from("users")
    .select("konto_type")
    .eq("id", brugerId)
    .maybeSingle<{ konto_type: string | null }>();
  return data?.konto_type === "erhverv";
}

// captchaToken: Turnstile-token fra login-siden (src/components/Turnstile.tsx).
// Sendes videre til Supabase Auth, som tjekker det, når CAPTCHA er slået til
// (docs/SIKKERHED-AUTH.md).
export async function logInd(
  emailInput: string,
  password: string,
  captchaToken?: string,
): Promise<Resultat> {
  const email = renEmail(emailInput);
  if (!email || typeof password !== "string" || password.length === 0) {
    return { fejl: "Forkert e-mail eller adgangskode.", kode: "forkert_login" };
  }

  // Hvert forsøg tælles op, FØR adgangskoden tjekkes (rate_limit_tjek er
  // atomisk), så loftet holder ved samtidige forsøg: 8 pr. e-mail+IP og 50
  // pr. IP pr. 15 min. Et gennemført login nulstiller e-mail+IP-tælleren.
  const ip = await klientIp();
  const graense = graenseFejl(await tjekGraenserLukket([["login_ip", ip], ["login_email_ip", `${email}|${ip}`]]));
  if (graense) return { fejl: graense };

  const supabase = await createClient();
  const token = renCaptchaToken(captchaToken);
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
    ...(token ? { options: { captchaToken: token } } : {}),
  });
  if (!error) await nulstilGraense("login_email_ip", `${email}|${ip}`);
  if (error) {
    if (erCaptchaFejl(error)) return { fejl: CAPTCHA_FEJL };
    // Supabase svarer kun email_not_confirmed, naar adgangskoden passer.
    // E-mailen gemmes i den httpOnly cookie, saa /tjek-indbakke kan vise den
    // og sende en ny kode.
    if (error.code === "email_not_confirmed") {
      await saetTjekEmailCookie(email);
      return {
        fejl: "Du mangler at bekræfte din e-mail. Indtast koden fra den mail, vi sendte dig.",
        kode: "email_ikke_bekraeftet",
      };
    }
    if (error.code === "invalid_credentials" || error.code === "user_banned") {
      return { fejl: "Forkert e-mail eller adgangskode.", kode: "forkert_login" };
    }
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    console.error("logInd fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }

  const resultat = await efterLogin(supabase, data.user, data.session?.access_token);
  if ("ok" in resultat && (await erFirmakonto(supabase, data.user.id))) return { ok: true, firma: true };
  return resultat;
}

// Oprettelse - samme kodevej for åben og lukket tilmelding og for appen
// (src/lib/kontoOprettelse.ts). Forskellen er kun invitationstjekket: mens
// tilmeldingen er lukket (beta), kan kun en e-mail med en aktiv invitation
// oprette sig, og kun mens chefen har beta åben.
//
// - Kontoen oprettes på serveren med en tilfældig adgangskode. Den valgte
//   gemmes krypteret i en kort cookie i brugerens browser
//   (src/lib/ventendeAdgangskode.ts) og sættes først efter en vellykket
//   verifyOtp (verificerSignupKode). Det gælder begge rækkefølger: opretter
//   en angriber kontoen først, eller prøver han bagefter, overlever hans
//   adgangskode aldrig offerets bekræftelse - og han kan ikke selv bekræfte
//   uden koden.
// - Samme svar i alle tilfælde (ikke inviteret, konto findes, ny konto,
//   fejl): "tjek din indbakke". Fejl logges i drift.
//
// vilkaarVersion: den version af brugerbetingelserne, brugeren har sat
// flueben ved. Uden accept af den aktuelle version oprettes ingen konto.
// Versionen sendes i signup-metadata; handle_new_user gemmer den med
// databasens tidspunkt (20261009050000_vilkaar_accept.sql).
export async function opretKonto(input: {
  fornavn: string;
  efternavn: string;
  email: string;
  password: string;
  vilkaarVersion: string;
  // Turnstile-token (docs/SIKKERHED-AUTH.md). Tjekkes af serveren selv, når
  // TURNSTILE_SECRET_KEY er sat - generateLink har ingen CAPTCHA.
  captchaToken?: string;
}): Promise<
  | { ok: true; bekraeftMail: boolean; beta?: true }
  | { fejl: string; felt?: "email" | "password" | "fornavn" | "efternavn" | "vilkaar" }
> {
  const email = renEmail(input?.email);
  const fornavn = renNavn(input?.fornavn);
  const efternavn = renNavn(input?.efternavn);
  const password = typeof input?.password === "string" ? input.password : "";

  // Fornavn og efternavn er begge paakraevet (Filip, 11. okt. 2026), ogsaa
  // naar actionen kaldes direkte. renNavn trimmer og skaerer ved 100 tegn.
  if (!fornavn) return { fejl: "Skriv dit fornavn.", felt: "fornavn" };
  if (!efternavn) return { fejl: "Skriv dit efternavn.", felt: "efternavn" };
  if (!email) return { fejl: "Indtast en gyldig e-mail.", felt: "email" };
  const v = vurderAdgangskode(password, { email, navn: [fornavn, efternavn] });
  if (!v.ok) return { fejl: v.fejl ?? GENERISK, felt: "password" };
  if (input?.vilkaarVersion !== VILKAAR_VERSION) {
    return { fejl: "Du skal acceptere brugerbetingelserne for at oprette en konto.", felt: "vilkaar" };
  }

  const ip = await klientIp();
  const graense = graenseFejl(await tjekGraenserLukket([["opret_ip", ip], ["gensend_email", email]]));
  if (graense) return { fejl: graense };
  if (!(await tjekTurnstile(input?.captchaToken, ip))) return { fejl: CAPTCHA_FEJL };

  // Navn, vilkår og adgangskode venter krypteret i browseren og sættes først,
  // når koden er indtastet (verificerSignupKode) - af den, der har koden.
  const gem = await opretKontoPaaServeren(email);
  if (gem === "ja" || (gem === "kun_hvis_ventende" && (await harVentendeAdgangskode(email)))) {
    await gemVentendeAdgangskode(email, {
      adgangskode: password,
      profil: { fornavn, efternavn, vilkaarVersion: VILKAAR_VERSION },
    });
  }
  await saetTjekEmailCookie(email);
  // beta: siden "Indtast koden" viser beta-teksten (samme for alle e-mails).
  return tilmeldingAaben() ? { ok: true, bekraeftMail: true } : { ok: true, bekraeftMail: true, beta: true };
}

// Sender en ny kode. Uden emailInput bruges adressen fra signup-cookien
// (siden "Indtast koden"). Samme svar, uanset om e-mailen har en konto; kun
// en eksisterende, ubekræftet konto får en ny kode (src/lib/kontoOprettelse.ts).
export async function gensendBekraeftelse(emailInput?: string): Promise<Resultat> {
  const email = renEmail(emailInput ?? (await cookies()).get(TJEK_EMAIL_COOKIE)?.value);
  if (!email) return { fejl: "Indtast en gyldig e-mail." };

  const ip = await klientIp();
  if (!(await tjekGraenser([["gensend_ip", ip], ["gensend_email", email]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  if ((await sendNyKodePaaServeren(email)) === "vent") {
    return { fejl: "Vent lidt, før du beder om en ny kode. Den forrige mail kan stadig være på vej." };
  }
  await saetTjekEmailCookie(email);
  return { ok: true };
}

// Den 6-cifrede kode fra bekraeftelsesmailen. Uden emailInput bruges
// adressen fra signup-cookien. Ved succes er brugeren logget ind
// (session-cookies saettes af verifyOtp), og enheden registreres - foerste
// login efter oprettelse giver ingen "Nyt login"-mail. Grænserne står i
// bekraeftKode (src/lib/kontoOprettelse.ts). Appen bruger POST
// /api/konto/bekraeft (docs/APP-SIGNUP.md).
export async function verificerSignupKode(
  kodeInput: string,
  emailInput?: string,
): Promise<Resultat | { fejl: string; kode: "kode_forkert" | "mangler_email" }> {
  const kode = renKode(kodeInput);
  if (!kode) return { fejl: "Skriv hele koden fra mailen.", kode: "kode_forkert" };

  const email = renEmail(emailInput || (await cookies()).get(TJEK_EMAIL_COOKIE)?.value);
  if (!email) return { fejl: "Indtast den e-mail, du oprettede kontoen med.", kode: "mangler_email" };

  // Adgangskode, navn og vilkårsaccept fra oprettelsen (krypteret cookie,
  // bundet til e-mailen). De sættes først i bekraeftKode, EFTER verifyOtp -
  // altså kun af den, der har koden fra mailen.
  const ventende = await hentVentendeAdgangskode(email);

  const ip = await klientIp();
  const supabase = await createClient();
  const svar = await bekraeftKode(supabase, {
    email,
    kode,
    ip,
    adgangskode: ventende?.adgangskode ?? null,
    profil: ventende?.profil ?? null,
  });
  if ("fejl" in svar) {
    if (svar.fejl === "konto") {
      await sletVentendeAdgangskode();
      if (svar.status.kode === "suspenderet") return { fejl: svar.status.besked };
      if (svar.status.kode === "slettet") return { fejl: "Forkert e-mail eller adgangskode.", kode: "forkert_login" };
      return { fejl: GENERISK };
    }
    if (svar.fejl === "for_mange") return { fejl: FOR_MANGE_FORSOEG };
    if (svar.fejl === "graense_fejl") return { fejl: PROEV_IGEN_OM_LIDT };
    if (svar.fejl === "kode_forkert") {
      return { fejl: "Koden passer ikke, eller den er udløbet. Tjek koden, eller få en ny.", kode: "kode_forkert" };
    }
    return { fejl: GENERISK };
  }

  (await cookies()).delete(TJEK_EMAIL_COOKIE);
  await sletVentendeAdgangskode();

  // Kontoen har kun en tilfældig adgangskode, hvis cookien manglede (anden
  // browser, over 30 min.) eller adgangskoden ikke kunne sættes: så sendes
  // brugeren til "Vælg adgangskode" (/reset-password?fra=signup), hvor navnet
  // også skrives. Vilkårene accepteres i accept-vinduet. Gælder både åben og
  // lukket tilmelding.
  const resultat = await efterLogin(supabase, svar.user, svar.session?.access_token);
  if ("ok" in resultat && !svar.adgangskodeSat) return { ...resultat, vaelgAdgangskode: true };
  if ("ok" in resultat && !svar.navnSat) return { ...resultat, bekraeftNavn: true };
  return resultat;
}

// "Glemt adgangskode". Samme kode som appens /api/konto/glemt
// (src/lib/adgangskodeSkift.ts): samme grænser og samme svar, uanset om
// e-mailen findes.
export async function nulstilAdgangskode(emailInput: string, captchaToken?: string): Promise<Resultat> {
  const r = await sendNulstillingsmail(await createClient(), emailInput, await klientIp(), captchaToken);
  return "fejl" in r ? { fejl: r.fejl } : { ok: true };
}

// Ny adgangskode efter nulstillingslinket (recovery-session). Brugeren
// logges ud bagefter og skal logge ind med den nye kode.
// navn: kun fra "Vælg din adgangskode" efter signup (/reset-password?fra=signup),
// når navnet ikke kom fra den, der har koden (anden browser) - så skrives det
// her. Gemmes med brugerens egen session, så databasens navneregler gælder
// (BHN01-03), og før adgangskoden.
export async function gemNyAdgangskode(
  password: string,
  navn?: { fornavn: unknown; efternavn: unknown },
): Promise<Resultat> {
  const supabase = await createClient();
  const { data: brugerData } = await supabase.auth.getUser();
  const bruger = brugerData.user;
  if (!bruger) return { fejl: "Linket er udløbet. Bed om et nyt og prøv igen." };

  const ip = await klientIp();
  // Egen pulje (ikke nulstil_ip): ellers kunne afsendte nulstillingsmails fra
  // samme IP blokere selve gemningen.
  const graense = graenseFejl(
    await tjekGraenserLukket([
      ["adgangskode_bruger", bruger.id],
      ["ny_adgangskode_ip_email", `${ip}|${bruger.email ?? bruger.id}`],
    ]),
  );
  if (graense) return { fejl: graense };

  const { data: profil } = await createAdminClient()
    .from("users")
    .select("navn, fornavn, efternavn")
    .eq("id", bruger.id)
    .maybeSingle();
  const fornavn = navn ? renNavn(navn.fornavn) : "";
  const efternavn = navn ? renNavn(navn.efternavn) : "";
  if (navn && !fornavn) return { fejl: "Skriv dit fornavn." };
  if (navn && !efternavn) return { fejl: "Skriv dit efternavn." };
  const v = vurderAdgangskode(password, {
    email: bruger.email,
    navn: navn ? [fornavn, efternavn] : [profil?.navn, profil?.fornavn, profil?.efternavn],
  });
  if (!v.ok) return { fejl: v.fejl ?? GENERISK };

  if (navn) {
    const { error: navnFejl } = await supabase
      .from("users")
      .update({ navn: `${fornavn} ${efternavn}`, fornavn, efternavn })
      .eq("id", bruger.id);
    if (navnFejl) {
      if (navnFejl.code === "BHN01") return { fejl: 'Navnet må ikke indeholde "BidHamr".' };
      if (navnFejl.code === "BHN02") {
        return { fejl: "Navnet må ikke indeholde en e-mail, et telefonnummer eller et link. Andre brugere kan se dit navn, så skriv kun dit navn." };
      }
      if (navnFejl.code === "BHN03") return { fejl: "Skriv dit efternavn." };
      console.error("gemNyAdgangskode: navn fejlede:", navnFejl.code, navnFejl.message);
      return { fejl: GENERISK };
    }
  }

  const { error: foersteFejl } = await supabase.auth.updateUser({ password });
  // Medarbejder med to-trins-login: linkets session er aal1 - se
  // saetAdgangskodeEfterMaillink (src/lib/adgangskodeSkift.ts).
  const error =
    foersteFejl?.code === "insufficient_aal"
      ? await saetAdgangskodeEfterMaillink(supabase, bruger.id, password)
      : foersteFejl;
  if (error) {
    if (error.code === "same_password") {
      return { fejl: "Den nye adgangskode skal være en anden end den gamle." };
    }
    if (error.code === "weak_password") {
      return { fejl: "Adgangskoden er for svag. Vælg en længere og mindre almindelig adgangskode." };
    }
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    if (error.code === "reauthentication_needed" || error.code === "insufficient_aal") {
      return { fejl: "Linket er for gammelt. Bed om et nyt og prøv igen." };
    }
    console.error("gemNyAdgangskode fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }

  // Log ud alle steder - ogsaa en evt. angriber med den gamle kode.
  await supabase.auth.signOut({ scope: "global" });
  if (bruger.email) {
    const res = await sendHandelMailDetaljer(bruger.email, adgangskodeAendretMail({ tidspunkt: new Date() }));
    if (!res.ok) await logDriftFejl({ kilde: "action", hvor: "adgangskodeAendretMail", fejl: res.fejl, brugerId: bruger.id });
  }
  return { ok: true };
}
