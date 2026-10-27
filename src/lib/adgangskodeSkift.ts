import "server-only";

// Skift adgangskode og "Glemt adgangskode" - ÉN kodevej for hjemmesiden
// (skiftAdgangskode i src/app/actions/kontoSikkerhed.ts og
// nulstilAdgangskode i src/app/actions/auth.ts) og appen
// (POST /api/konto/adgangskode og /api/konto/glemt, docs/APP-ENDPOINTS.md).
//
// Fejl RETURNERES som { fejl, kode } - fejl er en dansk tekst, der kan vises.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { FOR_MANGE_FORSOEG, graenseFejl, tjekGraenser, tjekGraenserLukket } from "@/lib/rateLimit";
import { vurderAdgangskode } from "@/lib/adgangskode";
import { bekraeftAdgangskode } from "@/lib/bekraeftAdgangskode";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { adgangskodeAendretMail } from "@/lib/mails/konto";
import { sideUrl } from "@/lib/mails/handel";
import { renEmail } from "@/lib/kontoOprettelse";
import { logDriftFejl } from "@/lib/drift";
import { CAPTCHA_FEJL, erCaptchaFejl, renCaptchaToken } from "@/lib/turnstile";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const SAMME = "Den nye adgangskode skal være en anden end den nuværende.";
const GENLOG_IND = "Af sikkerhedshensyn skal du logge ud og ind igen, før du kan skifte adgangskode.";

const TO_TRIN_SKIFT =
  "Du har to-trins-login som medarbejder. Brug \"Glemt adgangskode\" for at skifte adgangskoden – så får du et link på mail.";

export type AuthFejlInfo = { code?: string | null; status?: number | null; message?: string | null };

// Ny adgangskode fra linket i "Glemt adgangskode"-mailen for en medarbejder
// med to-trins-login (docs/ADMIN-VAERT.md): Supabase afviser updateUser med
// insufficient_aal, fordi linkets session er aal1. Er sessionen beviseligt
// fra et maillink (amr 'otp' eller 'recovery' højst 1 time gammel - tjekket
// i den verificerede JWT), sættes adgangskoden med admin-API'et. Alle
// sessioner logges ud (Supabase gør det selv ved updateUserById), ligesom
// gemNyAdgangskode alligevel logger ud alle steder. Ellers: fejlen som før.
// Brugere uden to-trins-login får aldrig insufficient_aal og rammer ikke
// denne vej. Admin (to-trins-login) er stadig beskyttet af koden fra app'en.
export async function saetAdgangskodeEfterMaillink(
  supabase: SupabaseClient,
  brugerId: string,
  ny: string,
): Promise<AuthFejlInfo | null> {
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || claims.sub !== brugerId) return { code: "insufficient_aal", status: 401 };
  const nu = Math.floor(Date.now() / 1000);
  const amr = Array.isArray(claims.amr) ? (claims.amr as { method?: unknown; timestamp?: unknown }[]) : [];
  const fraMaillink = amr.some(
    (e) =>
      (e?.method === "otp" || e?.method === "recovery") &&
      typeof e.timestamp === "number" &&
      nu - e.timestamp <= 3600 &&
      e.timestamp <= nu + 300,
  );
  if (!fraMaillink) return { code: "insufficient_aal", status: 401 };
  const { error: fejl } = await createAdminClient().auth.admin.updateUserById(brugerId, { password: ny });
  if (!fejl) return null;
  return { code: fejl.code ?? null, status: fejl.status ?? null, message: fejl.message };
}

export type SkiftSvar = { ok: true } | { fejl: string; kode: string };

// Brugeren skifter selv sin adgangskode (indlogget). Den nuværende
// adgangskode tjekkes, den nye skal opfylde de samme krav som ved oprettelse,
// andre enheder logges ud (denne bliver logget ind), og brugeren får en
// sikkerhedsmail. bruger SKAL være verificeret af kalderen (getUser).
// saetAdgangskode og logUdAndre gør det med brugerens egen session
// (cookie-session på hjemmesiden, Bearer-token i appen).
export async function skiftAdgangskodeFor(args: {
  bruger: { id: string; email?: string | null };
  nuvaerende: unknown;
  ny: unknown;
  saetAdgangskode: (ny: string) => Promise<AuthFejlInfo | null>;
  logUdAndre: () => Promise<AuthFejlInfo | null>;
}): Promise<SkiftSvar> {
  const { bruger } = args;
  if (!(await tjekGraenser([["adgangskode_bruger", bruger.id]]))) return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
  const nuvaerende = typeof args.nuvaerende === "string" ? args.nuvaerende : "";
  const ny = typeof args.ny === "string" ? args.ny : "";

  const { data: profil } = await createAdminClient()
    .from("users")
    .select("navn, fornavn, efternavn")
    .eq("id", bruger.id)
    .maybeSingle();
  const v = vurderAdgangskode(ny, { email: bruger.email, navn: [profil?.navn, profil?.fornavn, profil?.efternavn] });
  if (!v.ok) return { fejl: v.fejl ?? GENERISK, kode: "adgangskode" };
  if (ny === nuvaerende) return { fejl: SAMME, kode: "samme_adgangskode" };

  const tjek = await bekraeftAdgangskode(bruger.email, nuvaerende);
  if (tjek === "forkert") return { fejl: "Din nuværende adgangskode er forkert.", kode: "forkert_adgangskode" };
  if (tjek === "for_mange") return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
  if (tjek !== "ok") return { fejl: GENERISK, kode: "fejl" };

  const error = await args.saetAdgangskode(ny);
  if (error) {
    if (error.code === "same_password") return { fejl: SAMME, kode: "samme_adgangskode" };
    if (error.code === "weak_password") {
      return { fejl: "Adgangskoden er for svag. Vælg en længere og mindre almindelig adgangskode.", kode: "adgangskode" };
    }
    if (error.code === "reauthentication_needed") return { fejl: GENLOG_IND, kode: "genlog_ind" };
    // Medarbejder med to-trins-login (admin.bidhamr.dk): Supabase kræver en
    // aal2-session for at skifte adgangskode, og appen/hjemmesiden er aal1.
    // "Glemt adgangskode" virker (saetAdgangskodeEfterMaillink herunder).
    if (error.code === "insufficient_aal") return { fejl: TO_TRIN_SKIFT, kode: "genlog_ind" };
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
    console.error("skiftAdgangskode fejlede:", error.code, error.message);
    return { fejl: GENERISK, kode: "fejl" };
  }

  // Andre enheder logges ud - denne bliver logget ind.
  const udFejl = await args.logUdAndre();
  if (udFejl) console.error("skiftAdgangskode: andre sessioner blev ikke logget ud:", udFejl.message);
  if (bruger.email) {
    const res = await sendHandelMailDetaljer(bruger.email, adgangskodeAendretMail({ tidspunkt: new Date() }));
    if (!res.ok) await logDriftFejl({ kilde: "action", hvor: "sikkerhedsmail", fejl: res.fejl, brugerId: bruger.id });
  }
  return { ok: true };
}

// "Glemt adgangskode": sender Supabase' nulstillingsmail (linket går til
// hjemmesidens /auth/callback med token_hash - supabase/templates/recovery.html
// - og brugeren vælger den nye adgangskode på /reset-password). Svaret er det
// samme, uanset om e-mailen findes - kun "for mange forsøg" vises. klient er
// en Supabase-klient med den offentlige nøgle (ingen session nødvendig).
export async function sendNulstillingsmail(
  klient: SupabaseClient,
  emailInput: unknown,
  ip: string,
  // Turnstile-token (docs/SIKKERHED-AUTH.md) - tjekkes af Supabase Auth, når
  // CAPTCHA er slået til dér.
  captchaToken?: unknown,
): Promise<{ ok: true } | { fejl: string; kode: "email" | "for_mange" | "ikke_tilgaengelig" | "captcha" }> {
  const email = renEmail(emailInput);
  if (!email) return { fejl: "Indtast en gyldig e-mail.", kode: "email" };

  const graense = await tjekGraenserLukket([["nulstil_ip", ip], ["nulstil_email", email]]);
  const tekst = graenseFejl(graense);
  if (tekst) return { fejl: tekst, kode: graense === "for_mange" ? "for_mange" : "ikke_tilgaengelig" };

  const token = renCaptchaToken(captchaToken);
  const { error } = await klient.auth.resetPasswordForEmail(email, {
    redirectTo: sideUrl("/auth/callback?next=/reset-password"),
    ...(token ? { captchaToken: token } : {}),
  });
  if (error) {
    // CAPTCHA-fejl afslører ikke, om e-mailen findes - den vises.
    if (erCaptchaFejl(error)) return { fejl: CAPTCHA_FEJL, kode: "captcha" };
    // Kun "for mange forsøg" vises. Alle andre fejl giver samme svar som en
    // gennemført afsendelse, så svaret ikke afslører, om e-mailen findes.
    // Fejlen logges i drift uden e-mailadressen.
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
    await logDriftFejl({
      kilde: "action",
      hvor: "nulstilAdgangskode",
      fejl: `${error.status ?? ""} ${error.code ?? ""}: ${error.message}`.replace(/[^\s@]+@[^\s@]+/g, "[e-mail]"),
    });
  }
  return { ok: true };
}
