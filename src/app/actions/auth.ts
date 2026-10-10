"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  FOR_MANGE_FORSOEG,
  graenseFejl,
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

// Login, oprettelse, bekraeftelseskode (e-mail), gensend kode og nulstil
// adgangskode koeres paa serveren, saa de kan rate-limites pr. IP og pr.
// e-mail, og saa kravene til adgangskoden ikke kan omgaas fra browseren.
// Fejl RETURNERES (Next.js skjuler kastede fejl i produktion).
//
// BEMAERK: auth-API'et kan stadig kaldes direkte med anon-noeglen. Supabase
// Auths egne rate limits og adgangskodekrav (dashboard -> Auth) er det
// egentlige vaern; dette er et ekstra lag for hjemmesiden.

// firma: true = firmakonto (logInd) - login-siden sender så til /firma.
type Resultat = { ok: true; firma?: boolean } | { fejl: string; kode?: "email_ikke_bekraeftet" };

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
  { ok: true; bekraeftMail: boolean } | { fejl: string; felt?: "email" | "password" | "fornavn" | "vilkaar" }
> {
  if (!tilmeldingAaben()) return { fejl: "Det er ikke muligt at oprette en konto endnu." };

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

  const supabase = await createClient();
  const navn = [fornavn, efternavn].filter(Boolean).join(" ");
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
    return { fejl: GENERISK };
  }

  // Er "Confirm email" slaaet fra i Supabase, er brugeren logget ind med det
  // samme. Ellers skal mailen bekraeftes. Findes mailen allerede, svarer
  // Supabase som ved en ny konto (ingen afsloering af, hvem der er oprettet).
  if (data.session && data.user) {
    await registrerLogin({ brugerId: data.user.id, email, accessToken: data.session.access_token });
    return { ok: true, bekraeftMail: false };
  }

  await saetTjekEmailCookie(email);
  return { ok: true, bekraeftMail: true };
}

// Sender bekraeftelsesmailen (med en ny kode) igen. Uden emailInput bruges
// adressen fra signup-cookien (siden "Indtast koden").
export async function gensendBekraeftelse(emailInput?: string): Promise<Resultat> {
  const email = renEmail(emailInput ?? (await cookies()).get(TJEK_EMAIL_COOKIE)?.value);
  if (!email) return { fejl: "Indtast en gyldig e-mail." };

  const ip = await klientIp();
  if (!(await tjekGraenser([["gensend_ip", ip], ["gensend_email", email]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
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
  return efterLogin(supabase, data.user, data.session?.access_token);
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
