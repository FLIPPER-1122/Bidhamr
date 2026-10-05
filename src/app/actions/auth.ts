"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { sideUrl } from "@/lib/mails/handel";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { adgangskodeAendretMail } from "@/lib/mails/konto";
import { vurderAdgangskode } from "@/lib/adgangskode";
import { registrerLogin } from "@/lib/enheder";
import { harToTrin, manglerToTrin } from "@/lib/mfa";
import { TJEK_EMAIL_COOKIE, tilmeldingAaben } from "@/lib/tilmelding";
import { logDriftFejl } from "@/lib/drift";
import { hentKontoStatus } from "@/lib/kontoStatus";

// Login, oprettelse, gensend bekraeftelse, to-trins-login og nulstil
// adgangskode koeres paa serveren, saa de kan rate-limites pr. IP og pr.
// e-mail, og saa kravene til adgangskoden ikke kan omgaas fra browseren.
// Fejl RETURNERES (Next.js skjuler kastede fejl i produktion).
//
// BEMAERK: auth-API'et kan stadig kaldes direkte med anon-noeglen. Supabase
// Auths egne rate limits og adgangskodekrav (dashboard -> Auth) er det
// egentlige vaern; dette er et ekstra lag for hjemmesiden.

type Resultat = { ok: true } | { fejl: string; kode?: "email_ikke_bekraeftet" };

const GENERISK = "Noget gik galt. Prøv igen om lidt.";

function renEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 320 ? e : null;
}

function renNavn(v: unknown, maks = 100): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, maks) : "";
}

// Faelles efter et gennemfoert login (adgangskode + evt. to-trins-kode):
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
    if (status.kode === "slettet") return { fejl: "Forkert email eller adgangskode." };
    return { fejl: status.besked };
  }

  await registrerLogin({ brugerId: bruger.id, email: bruger.email, accessToken });
  return { ok: true };
}

export async function logInd(
  emailInput: string,
  password: string,
): Promise<{ ok: true; toTrin: boolean } | { fejl: string; kode?: "email_ikke_bekraeftet" }> {
  const email = renEmail(emailInput);
  if (!email || typeof password !== "string" || password.length === 0) {
    return { fejl: "Forkert email eller adgangskode." };
  }

  const ip = await klientIp();
  if (!(await tjekGraenser([["login_ip", ip], ["login_email_ip", `${email}|${ip}`]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "email_not_confirmed") {
      return {
        fejl: "Du mangler at bekræfte din e-mail. Klik på linket i den mail, vi sendte dig, da du oprettede kontoen.",
        kode: "email_ikke_bekraeftet",
      };
    }
    if (error.code === "invalid_credentials" || error.code === "user_banned") {
      return { fejl: "Forkert email eller adgangskode." };
    }
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    console.error("logInd fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }

  // To-trins-login: koden indtastes paa /login/to-trin. Foerst derefter
  // tjekkes suspension og enhed.
  if (harToTrin(data.user)) return { ok: true, toTrin: true };

  const svar = await efterLogin(supabase, data.user, data.session?.access_token);
  return "fejl" in svar ? svar : { ok: true, toTrin: false };
}

// Trin 2 af login: koden fra godkendelses-appen.
export async function bekraeftToTrin(kodeInput: string): Promise<Resultat> {
  const kode = typeof kodeInput === "string" ? kodeInput.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(kode)) return { fejl: "Koden består af 6 cifre." };

  const supabase = await createClient();
  const { data: brugerData } = await supabase.auth.getUser();
  const bruger = brugerData.user;
  if (!bruger) return { fejl: "Din login-session er udløbet. Log ind igen." };

  const ip = await klientIp();
  if (!(await tjekGraenser([["mfa_bruger", bruger.id], ["mfa_ip", ip]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  const faktor = bruger.factors?.find((f) => f.status === "verified" && f.factor_type === "totp");
  if (!faktor) return { fejl: GENERISK };

  const { data, error } = await supabase.auth.mfa.challengeAndVerify({ factorId: faktor.id, code: kode });
  if (error) {
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    if (error.code === "mfa_verification_failed" || error.status === 422 || error.status === 400) {
      return { fejl: "Koden passer ikke. Tjek, at uret på din telefon går rigtigt, og prøv med den nye kode." };
    }
    console.error("bekraeftToTrin fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }

  return efterLogin(supabase, bruger, data?.access_token);
}

// "Log ud" fra to-trins-siden (fx hvis man ikke har telefonen ved haanden).
export async function afbrydLogin(): Promise<{ ok: true }> {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  return { ok: true };
}

export async function opretKonto(input: {
  fornavn: string;
  efternavn: string;
  email: string;
  password: string;
}): Promise<{ ok: true; bekraeftMail: boolean } | { fejl: string; felt?: "email" | "password" | "fornavn" }> {
  if (!tilmeldingAaben()) return { fejl: "Det er ikke muligt at oprette en konto endnu." };

  const email = renEmail(input?.email);
  const fornavn = renNavn(input?.fornavn);
  const efternavn = renNavn(input?.efternavn);
  const password = typeof input?.password === "string" ? input.password : "";

  if (!fornavn) return { fejl: "Skriv dit fornavn.", felt: "fornavn" };
  if (!email) return { fejl: "Indtast en gyldig e-mail.", felt: "email" };
  const v = vurderAdgangskode(password, { email, navn: [fornavn, efternavn] });
  if (!v.ok) return { fejl: v.fejl ?? GENERISK, felt: "password" };

  const ip = await klientIp();
  if (!(await tjekGraenser([["opret_ip", ip], ["gensend_email", email]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  const supabase = await createClient();
  const navn = [fornavn, efternavn].filter(Boolean).join(" ");
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: sideUrl("/auth/callback?next=/velkommen"),
      data: { navn, fornavn, efternavn },
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

  (await cookies()).set(TJEK_EMAIL_COOKIE, email, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  return { ok: true, bekraeftMail: true };
}

// Sender bekraeftelsesmailen igen. Uden emailInput bruges adressen fra
// signup-cookien (siden "Tjek din indbakke").
export async function gensendBekraeftelse(emailInput?: string): Promise<Resultat> {
  const email = renEmail(emailInput ?? (await cookies()).get(TJEK_EMAIL_COOKIE)?.value);
  if (!email) return { fejl: "Indtast en gyldig email." };

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
      return { fejl: "Vent lidt, før du beder om en ny mail. Den forrige kan stadig være på vej." };
    }
    console.error("gensendBekraeftelse fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }

  (await cookies()).set(TJEK_EMAIL_COOKIE, email, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  return { ok: true };
}

export async function nulstilAdgangskode(emailInput: string): Promise<Resultat> {
  const email = renEmail(emailInput);
  if (!email) return { fejl: "Indtast en gyldig email." };

  const ip = await klientIp();
  if (!(await tjekGraenser([["nulstil_ip", ip], ["nulstil_email", email]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: sideUrl("/auth/callback?next=/reset-password"),
  });
  if (error) {
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    console.error("nulstilAdgangskode fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }
  return { ok: true };
}

// Ny adgangskode efter nulstillingslinket (recovery-session). Brugeren
// logges ud bagefter og skal logge ind med den nye kode.
// Har brugeren to-trins-login, kraever Supabase koden (aal2), foer
// adgangskoden kan aendres - derfor kodeInput.
export async function gemNyAdgangskode(
  password: string,
  kodeInput?: string,
): Promise<Resultat | { fejl: string; kode: "to_trin_kraeves" }> {
  const supabase = await createClient();
  const { data: brugerData } = await supabase.auth.getUser();
  const bruger = brugerData.user;
  if (!bruger) return { fejl: "Linket er udløbet. Bed om et nyt og prøv igen." };

  const ip = await klientIp();
  if (!(await tjekGraenser([["adgangskode_bruger", bruger.id], ["nulstil_ip", ip]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  if (await manglerToTrin(supabase, bruger)) {
    const kode = typeof kodeInput === "string" ? kodeInput.replace(/\s+/g, "") : "";
    if (!/^\d{6}$/.test(kode)) {
      return { fejl: "Indtast koden fra din godkendelses-app.", kode: "to_trin_kraeves" };
    }
    if (!(await tjekGraenser([["mfa_bruger", bruger.id], ["mfa_ip", ip]]))) {
      return { fejl: FOR_MANGE_FORSOEG };
    }
    const faktor = bruger.factors?.find((f) => f.status === "verified" && f.factor_type === "totp");
    const { error: mfaFejl } = faktor
      ? await supabase.auth.mfa.challengeAndVerify({ factorId: faktor.id, code: kode })
      : { error: new Error("ingen faktor") };
    if (mfaFejl) {
      return { fejl: "Koden passer ikke. Prøv med den nye kode fra din app.", kode: "to_trin_kraeves" };
    }
  }

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
    // Har brugeren to-trins-login, kraever Supabase koden foerst (aal2).
    if (error.code === "insufficient_aal") {
      return { fejl: "Du har to-trins-login slået til. Log ind med din kode først, og skift så adgangskoden under Min konto." };
    }
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
