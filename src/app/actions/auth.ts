"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  FOR_MANGE_FORSOEG,
  graenseFejl,
  indenForGraense,
  klientIp,
  nulstilGraense,
  tjekGraenser,
  tjekGraenserLukket,
} from "@/lib/rateLimit";
import { sideUrl } from "@/lib/mails/handel";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { adgangskodeAendretMail } from "@/lib/mails/konto";
import { vurderAdgangskode } from "@/lib/adgangskode";
import { registrerLogin } from "@/lib/enheder";
import { TJEK_EMAIL_COOKIE, tilmeldingAaben } from "@/lib/tilmelding";
import { logDriftFejl } from "@/lib/drift";
import { hentKontoStatus } from "@/lib/kontoStatus";
import { VILKAAR_VERSION } from "@/lib/vilkaar";
import { betaAuthBruger, betaTilmeldingTilladt } from "@/lib/beta";
import { gemVentendeAdgangskode, hentVentendeAdgangskode, sletVentendeAdgangskode } from "@/lib/ventendeAdgangskode";
import { betaKodeMail } from "@/lib/mails/beta";

// Login, oprettelse, bekraeftelseskode (e-mail), gensend kode og nulstil
// adgangskode koeres paa serveren, saa de kan rate-limites pr. IP og pr.
// e-mail, og saa kravene til adgangskoden ikke kan omgaas fra browseren.
// Fejl RETURNERES (Next.js skjuler kastede fejl i produktion).
//
// BEMAERK: auth-API'et kan stadig kaldes direkte med anon-noeglen. Supabase
// Auths egne rate limits og adgangskodekrav (dashboard -> Auth) er det
// egentlige vaern; dette er et ekstra lag for hjemmesiden.

// firma: true = firmakonto (logInd) - login-siden sender så til /firma.
// vaelgAdgangskode: efter bekræftelse skal brugeren vælge en adgangskode
// (/reset-password) - se verificerSignupKode.
type Resultat =
  | { ok: true; firma?: boolean; vaelgAdgangskode?: true }
  | { fejl: string; kode?: "email_ikke_bekraeftet" };

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

function renEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 320 ? e : null;
}

function renNavn(v: unknown, maks = 100): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, maks) : "";
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
    if (status.kode === "slettet") return { fejl: "Forkert e-mail eller adgangskode." };
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

export async function logInd(
  emailInput: string,
  password: string,
): Promise<Resultat> {
  const email = renEmail(emailInput);
  if (!email || typeof password !== "string" || password.length === 0) {
    return { fejl: "Forkert e-mail eller adgangskode." };
  }

  // Hvert forsøg tælles op, FØR adgangskoden tjekkes (rate_limit_tjek er
  // atomisk), så loftet holder ved samtidige forsøg: 8 pr. e-mail+IP og 50
  // pr. IP pr. 15 min. Et gennemført login nulstiller e-mail+IP-tælleren.
  const ip = await klientIp();
  const graense = graenseFejl(await tjekGraenserLukket([["login_ip", ip], ["login_email_ip", `${email}|${ip}`]]));
  if (graense) return { fejl: graense };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error) await nulstilGraense("login_email_ip", `${email}|${ip}`);
  if (error) {
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
      return { fejl: "Forkert e-mail eller adgangskode." };
    }
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    console.error("logInd fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }

  const resultat = await efterLogin(supabase, data.user, data.session?.access_token);
  if ("ok" in resultat && (await erFirmakonto(supabase, data.user.id))) return { ok: true, firma: true };
  return resultat;
}

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
}): Promise<
  | { ok: true; bekraeftMail: boolean; beta?: true }
  | { fejl: string; felt?: "email" | "password" | "fornavn" | "vilkaar" }
> {
  // Lukket tilmelding: kun inviterede beta-testere (opretBetaKonto nedenfor).
  // Siden /signup viser kun formularen, når beta er åben.
  const kunBeta = !tilmeldingAaben();

  const email = renEmail(input?.email);
  const fornavn = renNavn(input?.fornavn);
  const efternavn = renNavn(input?.efternavn);
  const password = typeof input?.password === "string" ? input.password : "";

  if (!fornavn) return { fejl: "Skriv dit fornavn.", felt: "fornavn" };
  if (!email) return { fejl: "Indtast en gyldig e-mail.", felt: "email" };
  const v = vurderAdgangskode(password, { email, navn: [fornavn, efternavn] });
  if (!v.ok) return { fejl: v.fejl ?? GENERISK, felt: "password" };
  if (input?.vilkaarVersion !== VILKAAR_VERSION) {
    return { fejl: "Du skal acceptere brugerbetingelserne for at oprette en konto.", felt: "vilkaar" };
  }

  const ip = await klientIp();
  const graense = graenseFejl(await tjekGraenserLukket([["opret_ip", ip], ["gensend_email", email]]));
  if (graense) return { fejl: graense };

  const navn = [fornavn, efternavn].filter(Boolean).join(" ");
  if (kunBeta) return opretBetaKonto({ email, password, navn, fornavn, efternavn });

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: sideUrl("/auth/callback?next=/velkommen"),
      data: { navn, fornavn, efternavn, vilkaar_version: VILKAAR_VERSION },
    },
  });

  if (error) {
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    if (error.code === "user_already_exists" || error.code === "email_exists") {
      return {
        fejl: "Der findes allerede en konto med den e-mail. Log ind, eller nulstil din adgangskode.",
        felt: "email",
      };
    }
    if (error.code === "weak_password") {
      return { fejl: "Adgangskoden er for svag. Vælg en længere og mindre almindelig adgangskode.", felt: "password" };
    }
    if (error.code === "signup_disabled") return { fejl: "Det er ikke muligt at oprette en konto endnu." };
    if (error.code === "email_address_invalid" || error.code === "email_address_not_authorized") {
      return { fejl: "Vi kan ikke sende mail til den adresse. Tjek, at den er skrevet rigtigt.", felt: "email" };
    }
    console.error("opretKonto fejlede:", error.code, error.message);
    // Databasens værn (handle_new_user -> beta_tjek_ny_bruger) afviser nye
    // konti, så længe beta_indstillinger.kun_inviterede er slået til. Er
    // TILMELDING_AABEN sat uden at slå værnet fra, ender alle her.
    if (error.status === 500 && /database error/i.test(error.message ?? "")) {
      await logDriftFejl({
        kilde: "action",
        hvor: "opretKonto",
        fejl: `Supabase afviste en ny konto (${error.code ?? ""}: ${error.message}). Er beta_indstillinger.kun_inviterede stadig slået til, selvom tilmeldingen er åben? Se HUSKELISTE.md under "Lancering".`,
      });
    }
    return { fejl: GENERISK };
  }

  // Er "Confirm email" slaaet fra i Supabase, er brugeren logget ind med det
  // samme. Ellers skal mailen bekraeftes. Findes mailen allerede, svarer
  // Supabase som ved en ny konto (ingen afsloering af, hvem der er oprettet).
  if (data.session && data.user) {
    await registrerLogin({ brugerId: data.user.id, email, accessToken: data.session.access_token });
    return { ok: true, bekraeftMail: false };
  }

  // Samme værn som under beta: findes e-mailen allerede som ubekræftet konto
  // (fx oprettet af en anden med en anden adgangskode), sender Supabase bare
  // en ny kode. Den valgte adgangskode sættes derfor efter bekræftelsen
  // (verificerSignupKode), så kun den, der har koden, bestemmer den.
  await gemVentendeAdgangskode(email, password);
  await saetTjekEmailCookie(email);
  return { ok: true, bekraeftMail: true };
}

// Beta-testen (docs/BETA-TEST.md): mens tilmeldingen er lukket, kan kun en
// e-mail med en aktiv invitation oprette sig - og kun mens chefen har beta
// åben. Databasen tjekker det samme igen (handle_new_user ->
// beta_tjek_ny_bruger), så det ikke kan omgås med anon-nøglen.
// "Allow new users to sign up" er slået fra i Supabase i produktion, så en
// NY konto oprettes med service-role via generateLink('signup') (sender ingen
// mail). Koden sendes i vores egen mail (betaKodeMail) og indtastes på
// /tjek-indbakke (verifyOtp type 'signup').
//
// Sikkerhed (review 11. okt. 2026):
// - Adgangskoden bestemmes KUN af den, der har koden fra mailen. Kontoen
//   oprettes ALTID med en tilfældig adgangskode. Den valgte gemmes krypteret
//   i en kort cookie i brugerens browser (src/lib/ventendeAdgangskode.ts) og
//   sættes først efter en vellykket verifyOtp (verificerSignupKode). Det
//   gælder begge rækkefølger: opretter en angriber kontoen først, eller
//   prøver han bagefter, overlever hans adgangskode aldrig offerets
//   bekræftelse - og han kan ikke selv bekræfte uden koden.
// - En EKSISTERENDE konto (slået op i auth.users) får aldrig ny metadata
//   eller adgangskode herfra. Er den ubekræftet, sendes kun en ny kode
//   (sendBetaKodeIgen).
// - Samme svar i alle tilfælde (ikke inviteret, beta lukket, konto findes,
//   ny konto, fejl): "tjek din indbakke" (beta: true). Fejl logges i drift.
// - Højst én kodemail pr. e-mail hvert 2. minut (beta_kode_email, tjekket
//   før alt andet). Inden for de 2 minutter sendes intet, så den forrige
//   kode stadig gælder.
function tilfaeldigAdgangskode(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `Bh-${Buffer.from(b).toString("base64url")}-9x`;
}

async function logBetaFejl(hvor: string, fejl: unknown, brugerId?: string) {
  const tekst = fejl instanceof Error ? fejl.message : typeof fejl === "string" ? fejl : JSON.stringify(fejl);
  await logDriftFejl({
    kilde: "action",
    hvor,
    fejl: String(tekst).replace(/[^\s@]+@[^\s@]+/g, "[e-mail]"),
    ...(brugerId ? { brugerId } : {}),
  });
}

// Ny kode til en EKSISTERENDE, ubekræftet konto. Først Supabases egen mail
// (auth.resend). Virker den ikke (fx fordi "Allow new users to sign up" er
// slået fra), laves en ny kode med generateLink('signup') på den
// eksisterende konto - UDEN metadata og med en tilfældig adgangskode (den
// rigtige sættes først efter bekræftelsen) - og den sendes i vores egen mail.
// true = en kode er sendt.
async function sendBetaKodeIgen(email: string): Promise<boolean> {
  const supabase = await createClient();
  const { error: resendFejl } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: sideUrl("/auth/callback?next=/velkommen") },
  });
  if (!resendFejl) return true;
  await logBetaFejl("sendBetaKodeIgen.resend", `${resendFejl.status ?? ""} ${resendFejl.code ?? ""}: ${resendFejl.message}`);

  const { data: link, error } = await createAdminClient().auth.admin.generateLink({
    type: "signup",
    email,
    password: tilfaeldigAdgangskode(),
  });
  if (error || !link?.properties?.email_otp) {
    await logBetaFejl("sendBetaKodeIgen.generateLink", `${error?.status ?? ""} ${error?.code ?? ""}: ${error?.message ?? "intet svar"}`);
    return false;
  }
  const sendt = await sendHandelMailDetaljer(email, betaKodeMail({ email, kode: link.properties.email_otp }));
  if (!sendt.ok) {
    await logBetaFejl("sendBetaKodeIgen.kodeMail", sendt.fejl, link.user?.id);
    return false;
  }
  return true;
}

async function opretBetaKonto(input: {
  email: string;
  password: string;
  navn: string;
  fornavn: string;
  efternavn: string;
}): Promise<{ ok: true; bekraeftMail: true; beta: true }> {
  const { email, password, navn, fornavn, efternavn } = input;
  const svar = async () => {
    await saetTjekEmailCookie(email);
    return { ok: true as const, bekraeftMail: true as const, beta: true as const };
  };

  if (!(await indenForGraense("beta_kode_email", email))) return svar();

  const tilladt = await betaTilmeldingTilladt(email);
  if (tilladt === null) {
    await logBetaFejl("opretBetaKonto", "Invitationen kunne ikke tjekkes (beta_tilmelding_tilladt).");
    return svar();
  }
  if (!tilladt) return svar();

  const findes = await betaAuthBruger(email);
  if (findes === null) {
    await logBetaFejl("opretBetaKonto", "Kontoen kunne ikke slås op (beta_auth_bruger).");
    return svar();
  }
  if (findes.findes) {
    // Bekræftet konto: intet. Ubekræftet: kun en ny kode - og den valgte
    // adgangskode venter i cookien, til koden er indtastet.
    if (!findes.bekraeftet && (await sendBetaKodeIgen(email))) {
      await gemVentendeAdgangskode(email, password);
    }
    return svar();
  }

  const { data: link, error } = await createAdminClient().auth.admin.generateLink({
    type: "signup",
    email,
    password: tilfaeldigAdgangskode(),
    options: {
      redirectTo: sideUrl("/auth/callback?next=/velkommen"),
      data: { navn, fornavn, efternavn, vilkaar_version: VILKAAR_VERSION },
    },
  });
  if (error || !link?.user || !link.properties?.email_otp) {
    // Alt (også weak_password, 429, "findes allerede" og databasens værn)
    // giver samme svar; det uventede logges.
    const forventet =
      error?.code === "email_exists" ||
      error?.code === "user_already_exists" ||
      (error?.status === 500 && /database error/i.test(error.message ?? ""));
    if (!forventet) {
      await logBetaFejl("opretBetaKonto.generateLink", `${error?.status ?? ""} ${error?.code ?? ""}: ${error?.message ?? "intet svar"}`);
    }
    return svar();
  }

  const sendt = await sendHandelMailDetaljer(email, betaKodeMail({ email, kode: link.properties.email_otp }));
  if (!sendt.ok) {
    // Kontoen findes; brugeren kan få en ny kode på /tjek-indbakke.
    await logBetaFejl("opretBetaKonto.kodeMail", sendt.fejl, link.user.id);
  }
  await gemVentendeAdgangskode(email, password);
  return svar();
}

// Sender bekraeftelsesmailen (med en ny kode) igen. Uden emailInput bruges
// adressen fra signup-cookien (siden "Indtast koden").
// Mens tilmeldingen er lukket (beta), sendes der kun en ny kode til en
// e-mail med en aktiv invitation; andre får samme svar uden mail.
export async function gensendBekraeftelse(emailInput?: string): Promise<Resultat> {
  const email = renEmail(emailInput ?? (await cookies()).get(TJEK_EMAIL_COOKIE)?.value);
  if (!email) return { fejl: "Indtast en gyldig e-mail." };

  const ip = await klientIp();
  if (!(await tjekGraenser([["gensend_ip", ip], ["gensend_email", email]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  if (!tilmeldingAaben()) {
    // Samme 2-minutters loft pr. e-mail som opretBetaKonto - tjekket før
    // invitationen, så svaret er det samme for alle e-mails.
    if (!(await indenForGraense("beta_kode_email", email))) {
      return { fejl: "Vent lidt, før du beder om en ny kode. Den forrige mail kan stadig være på vej." };
    }
    // Samme svar, uanset om e-mailen er inviteret eller har en konto. Kun en
    // eksisterende, ubekræftet konto med aktiv invitation får en ny kode
    // (resend, ellers generateLink + egen mail - sendBetaKodeIgen). Fejl
    // logges i drift.
    const tilladt = await betaTilmeldingTilladt(email);
    if (tilladt === null) await logBetaFejl("gensendBekraeftelse", "Invitationen kunne ikke tjekkes.");
    if (tilladt) {
      const findes = await betaAuthBruger(email);
      if (findes === null) await logBetaFejl("gensendBekraeftelse", "Kontoen kunne ikke slås op (beta_auth_bruger).");
      if (findes?.findes && !findes.bekraeftet) await sendBetaKodeIgen(email);
    }
    await saetTjekEmailCookie(email);
    return { ok: true };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: sideUrl("/auth/callback?next=/velkommen") },
  });
  if (error) {
    if (error.status === 429) {
      return { fejl: "Vent lidt, før du beder om en ny kode. Den forrige mail kan stadig være på vej." };
    }
    console.error("gensendBekraeftelse fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }

  await saetTjekEmailCookie(email);
  return { ok: true };
}

// Den 6-cifrede kode fra bekraeftelsesmailen ({{ .Token }} i
// supabase/templates/confirmation.html). Uden emailInput bruges adressen fra
// signup-cookien. Ved succes er brugeren logget ind (session-cookies saettes
// af verifyOtp), og enheden registreres - foerste login efter oprettelse
// giver ingen "Nyt login"-mail. Alle forsoeg taelles: hoejst 5 pr. e-mail+IP
// og 30 pr. IP pr. 15 min; et gennemfoert forsoeg nulstiller e-mail+IP.
// Appen bruger samme kald direkte: supabase.auth.verifyOtp({ email, token,
// type: "signup" }).
export async function verificerSignupKode(
  kodeInput: string,
  emailInput?: string,
): Promise<Resultat | { fejl: string; kode: "kode_forkert" | "mangler_email" }> {
  const kode = typeof kodeInput === "string" ? kodeInput.replace(/\D/g, "") : "";
  // Produktion bruger 6 cifre ("Email OTP length"). Supabase tillader 6-10,
  // så andre laengder afvises ikke her (testdatabasen bruger 8).
  if (!/^\d{6,10}$/.test(kode)) return { fejl: "Koden består af 6 cifre.", kode: "kode_forkert" };

  const email = renEmail(emailInput || (await cookies()).get(TJEK_EMAIL_COOKIE)?.value);
  if (!email) return { fejl: "Indtast den e-mail, du oprettede kontoen med.", kode: "mangler_email" };

  const ip = await klientIp();
  const graense = graenseFejl(
    await tjekGraenserLukket([
      ["signup_kode_ip", ip],
      ["signup_kode_email_ip", `${email}|${ip}`],
      ["signup_kode_email", email],
    ]),
  );
  if (graense) return { fejl: graense };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ email, token: kode, type: "signup" });
  if (error || !data.user) {
    if (error?.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    // Supabase svarer otp_expired baade ved forkert og udloebet kode, saa
    // teksten daekker begge dele.
    if (error && (error.code === "otp_expired" || error.status === 403 || error.status === 400)) {
      return { fejl: "Koden passer ikke, eller den er udløbet. Tjek koden, eller få en ny.", kode: "kode_forkert" };
    }
    console.error("verificerSignupKode fejlede:", error?.code, error?.message);
    return { fejl: GENERISK };
  }

  await nulstilGraense("signup_kode_email_ip", `${email}|${ip}`);
  (await cookies()).delete(TJEK_EMAIL_COOKIE);

  // Den adgangskode, brugeren valgte ved oprettelsen, sættes først nu - i
  // sessionen fra verifyOtp, altså kun af den, der har koden fra mailen (se
  // src/lib/ventendeAdgangskode.ts). Bundet til den bekræftede kontos e-mail.
  // Under beta har kontoen ellers kun en tilfældig adgangskode: mangler
  // cookien (anden browser, over 30 min.) eller kan adgangskoden ikke sættes,
  // sendes brugeren til "Vælg adgangskode" (/reset-password).
  const kontoEmail = (data.user.email ?? email).toLowerCase();
  const ventende = await hentVentendeAdgangskode(kontoEmail);
  await sletVentendeAdgangskode();
  let vaelgAdgangskode = !tilmeldingAaben() && !ventende;
  if (ventende) {
    const { error: pwFejl } = await supabase.auth.updateUser({ password: ventende });
    if (pwFejl && pwFejl.code !== "same_password") {
      await logDriftFejl({
        kilde: "action",
        hvor: "verificerSignupKode.adgangskode",
        fejl: `${pwFejl.status ?? ""} ${pwFejl.code ?? ""}: ${pwFejl.message}`,
        brugerId: data.user.id,
      });
      // Uvist, hvis adgangskode kontoen har - brugeren vælger en ny.
      vaelgAdgangskode = true;
    }
  }

  const resultat = await efterLogin(supabase, data.user, data.session?.access_token);
  if ("ok" in resultat && vaelgAdgangskode) return { ...resultat, vaelgAdgangskode: true };
  return resultat;
}

export async function nulstilAdgangskode(emailInput: string): Promise<Resultat> {
  const email = renEmail(emailInput);
  if (!email) return { fejl: "Indtast en gyldig e-mail." };

  const ip = await klientIp();
  const graense = graenseFejl(await tjekGraenserLukket([["nulstil_ip", ip], ["nulstil_email", email]]));
  if (graense) return { fejl: graense };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: sideUrl("/auth/callback?next=/reset-password"),
  });
  if (error) {
    // Kun "for mange forsøg" vises. Alle andre fejl giver samme svar som en
    // gennemført afsendelse, så svaret ikke afslører, om e-mailen findes.
    // Fejlen logges i drift uden e-mailadressen.
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    await logDriftFejl({
      kilde: "action",
      hvor: "nulstilAdgangskode",
      fejl: `${error.status ?? ""} ${error.code ?? ""}: ${error.message}`.replace(/[^\s@]+@[^\s@]+/g, "[e-mail]"),
    });
  }
  return { ok: true };
}

// Ny adgangskode efter nulstillingslinket (recovery-session). Brugeren
// logges ud bagefter og skal logge ind med den nye kode.
export async function gemNyAdgangskode(password: string): Promise<Resultat> {
  const supabase = await createClient();
  const { data: brugerData } = await supabase.auth.getUser();
  const bruger = brugerData.user;
  if (!bruger) return { fejl: "Linket er udløbet. Bed om et nyt og prøv igen." };

  const ip = await klientIp();
  const graense = graenseFejl(await tjekGraenserLukket([["adgangskode_bruger", bruger.id], ["nulstil_ip", ip]]));
  if (graense) return { fejl: graense };

  const { data: profil } = await createAdminClient()
    .from("users")
    .select("navn, fornavn, efternavn")
    .eq("id", bruger.id)
    .maybeSingle();
  const v = vurderAdgangskode(password, {
    email: bruger.email,
    navn: [profil?.navn, profil?.fornavn, profil?.efternavn],
  });
  if (!v.ok) return { fejl: v.fejl ?? GENERISK };

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    if (error.code === "same_password") {
      return { fejl: "Den nye adgangskode skal være en anden end den gamle." };
    }
    if (error.code === "weak_password") {
      return { fejl: "Adgangskoden er for svag. Vælg en længere og mindre almindelig adgangskode." };
    }
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    if (error.code === "reauthentication_needed") {
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
