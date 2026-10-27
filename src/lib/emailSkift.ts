import "server-only";

// Skift af e-mail - ÉN kodevej for hjemmesiden (src/app/actions/emailSkift.ts)
// og appen (POST /api/konto/email og /api/konto/email/bekraeft,
// docs/APP-ENDPOINTS.md). Reglerne: ROADMAP-BESLUTNINGER.md, "Skift af
// e-mail" (Filip, 27. okt. 2026), og migrationen 20261102120000_skift_email.sql.
//
//   1. anmodEmailSkiftFor: ny e-mail + nuværende adgangskode. Er adressen
//      ledig, sendes en kode på 6 cifre til den NYE adresse. Svaret er det
//      samme, uanset om adressen er i brug.
//   2. bekraeftEmailSkiftFor: koden. Først nu skifter login-adressen
//      (Supabase' admin-API). Databasen spejler public.users.email,
//      firmaets kontakt_email og loggen i samme transaktion (trigger på
//      auth.users). Andre enheder logges ud, den gamle adresse får en mail,
//      og Stripe-kunden/Connect-kontoen får den nye adresse.
//
// Staff-konti (medarbejder, admin, chef, erhvervssælger) kan IKKE selv skifte
// e-mail - de kontakter chefen. Firmakonti (konto_type 'erhverv') kontakter
// BidHamr (firmaoplysninger rettes hos BidHamr). Suspenderede, lukkede og
// slettede konti kan heller ikke.
//
// Ved skiftet dør alle gamle links og koder (nulstilling, bekræftelse,
// genbekræftelse) til den gamle adresse - trigger på auth.users
// (20261102160000_skift_email_rettelser.sql).
//
// bruger SKAL være verificeret af kalderen (getUser). Fejl RETURNERES som
// { fejl, kode } - fejl er en dansk tekst, der kan vises direkte.

import { createHmac, randomInt } from "node:crypto";
import { after } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { hemmeligNoegle } from "@/lib/supabase/noeglerServer";
import { FOR_MANGE_FORSOEG, graenseFejl, nulstilGraense, tjekGraenserLukket } from "@/lib/rateLimit";
import { bekraeftAdgangskode } from "@/lib/bekraeftAdgangskode";
import { renEmail } from "@/lib/kontoOprettelse";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { emailAendretMail, emailSkiftKodeMail } from "@/lib/mails/konto";
import { logDriftFejl } from "@/lib/drift";
import { getStripe } from "@/lib/stripe";
import type { AuthFejlInfo } from "@/lib/adgangskodeSkift";

export const EMAIL_SKIFT = {
  generisk: "Noget gik galt. Prøv igen om lidt.",
  kodeSendt: "Vi har sendt en kode til den nye adresse, hvis den kan bruges. Koden gælder i 15 minutter.",
  ugyldigEmail: "Skriv en gyldig e-mail.",
  samme: "Det er allerede din e-mail.",
  forkertAdgangskode: "Din nuværende adgangskode er forkert.",
  staff: "Medarbejderkonti kan ikke selv skifte e-mail. Kontakt chefen, så skifter chefen den for dig.",
  firma: "Kontakt BidHamr for at skifte e-mail på en firmakonto.",
  igang: "Dit skift af e-mail er ved at blive gennemført. Prøv igen om et par minutter.",
  suspenderet: "Du kan ikke skifte e-mail, mens din konto er suspenderet. Skriv til support@bidhamr.dk.",
  lukket: "Din konto er lukket, så du kan ikke skifte e-mail. Skriv til support@bidhamr.dk.",
  slettet: "Kontoen er slettet.",
  kodeForkert: "Koden passer ikke. Tjek mailen, og prøv igen.",
  kodeUdloebet: "Koden er udløbet eller brugt. Bed om en ny kode.",
  kodeForMange: "Du har tastet forkert for mange gange. Bed om en ny kode.",
  kodeFormat: "Skriv de 6 cifre fra mailen.",
  optaget: "Den nye e-mail kan ikke bruges. Vælg en anden adresse.",
} as const;

export type EmailSkiftKode =
  | "email"
  | "samme_email"
  | "forkert_adgangskode"
  | "for_mange"
  | "ikke_tilgaengelig"
  | "staff"
  | "firma"
  | "suspenderet"
  | "lukket"
  | "slettet"
  | "kode_forkert"
  | "kode_udloebet"
  | "optaget"
  | "fejl";

export type EmailSkiftFejl = { fejl: string; kode: EmailSkiftKode };

const KODE_RE = /^\d{6}$/;

export function nyEmailKode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

// Koden bindes til brugeren. Kun hashen gemmes (email_skift.kode_hash) - en
// HMAC med serverens hemmelige Supabase-nøgle (hemmeligNoegle kaster en
// tydelig fejl, hvis den mangler), så en lækket tabel ikke kan knækkes ved at
// prøve alle 1.000.000 koder. Skiftes nøglen, holder koder, der er sendt
// inden for de sidste 15 minutter, op med at virke (brugeren beder om en ny).
export function hashEmailKode(brugerId: string, kode: string): string {
  return createHmac("sha256", `bidhamr-email-skift-v2|${hemmeligNoegle()}`)
    .update(`${brugerId.toLowerCase()}|${kode}`)
    .digest("hex");
}

export function renEmailKode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const k = v.replace(/\s+/g, "");
  return KODE_RE.test(k) ? k : null;
}

function spaerreFejl(kode: string | null | undefined): EmailSkiftFejl | null {
  switch (kode) {
    case "staff":
      return { fejl: EMAIL_SKIFT.staff, kode: "staff" };
    case "firma":
      return { fejl: EMAIL_SKIFT.firma, kode: "firma" };
    case "suspenderet":
      return { fejl: EMAIL_SKIFT.suspenderet, kode: "suspenderet" };
    case "lukket":
      return { fejl: EMAIL_SKIFT.lukket, kode: "lukket" };
    case "slettet":
    case "ukendt":
      return { fejl: EMAIL_SKIFT.slettet, kode: "slettet" };
    default:
      return null;
  }
}

// Må kontoen skifte e-mail? Tjekkes før adgangskoden (staff får beskeden med
// det samme). Databasen tjekker igen i email_skift_anmod/-tjek.
async function kontoSpaerret(brugerId: string): Promise<EmailSkiftFejl | null> {
  const { data, error } = await createAdminClient().rpc("email_skift_konto_spaerret", { p_bruger: brugerId });
  if (error) {
    console.error("email_skift_konto_spaerret fejlede:", error.message);
    return { fejl: EMAIL_SKIFT.generisk, kode: "fejl" };
  }
  return spaerreFejl(typeof data === "string" ? data : null);
}

// Svaret "Vi har sendt en kode ..." gives tidligst EMAIL_SKIFT_SVARTID.minMs
// efter anmodningen - uanset om adressen er ledig (mailen sendes i
// baggrunden med after()), i brug (ingen mail) eller Resend fejler (logges).
// Så afslører svartiden ikke, om adressen findes. Sættes ned i testene.
export const EMAIL_SKIFT_SVARTID = { minMs: 1500 };

function ventTil(start: number): Promise<void> {
  const rest = start + EMAIL_SKIFT_SVARTID.minMs - Date.now();
  return rest > 0 ? new Promise((r) => setTimeout(r, rest)) : Promise.resolve();
}

// ------------------------------------------------------------ 1. Anmodning

export async function anmodEmailSkiftFor(args: {
  bruger: Pick<User, "id" | "email">;
  nyEmail: unknown;
  adgangskode: unknown;
}): Promise<{ ok: true; besked: string } | EmailSkiftFejl> {
  const start = Date.now();
  const { bruger } = args;
  const nyEmail = renEmail(args.nyEmail);
  if (!nyEmail || nyEmail.endsWith(".invalid")) return { fejl: EMAIL_SKIFT.ugyldigEmail, kode: "email" };
  if (nyEmail === (bruger.email ?? "").toLowerCase()) return { fejl: EMAIL_SKIFT.samme, kode: "samme_email" };

  // Grænser (fail closed): adgangskode_bruger deles med skift af
  // adgangskode og sletning (gæt på adgangskoden), email_skift_bruger mod
  // mailbomber fra én konto. email_skift_ny_email (mod mailbomber til én
  // fremmed adresse) tælles først efter en godkendt adgangskode, så en, der
  // gætter adgangskoder, ikke kan spærre adressen for andre.
  const graense = await tjekGraenserLukket([
    ["adgangskode_bruger", bruger.id],
    ["email_skift_bruger", bruger.id],
  ]);
  const graenseTekst = graenseFejl(graense);
  if (graenseTekst) return { fejl: graenseTekst, kode: graense === "for_mange" ? "for_mange" : "ikke_tilgaengelig" };

  const spaerret = await kontoSpaerret(bruger.id);
  if (spaerret) return spaerret;

  const adgangskode = typeof args.adgangskode === "string" ? args.adgangskode : "";
  const tjek = await bekraeftAdgangskode(bruger.email, adgangskode);
  if (tjek === "forkert") return { fejl: EMAIL_SKIFT.forkertAdgangskode, kode: "forkert_adgangskode" };
  if (tjek === "for_mange") return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
  if (tjek !== "ok") return { fejl: EMAIL_SKIFT.generisk, kode: "fejl" };

  const graenseNy = await tjekGraenserLukket([["email_skift_ny_email", nyEmail]]);
  const graenseNyTekst = graenseFejl(graenseNy);
  if (graenseNyTekst) return { fejl: graenseNyTekst, kode: graenseNy === "for_mange" ? "for_mange" : "ikke_tilgaengelig" };

  const kode = nyEmailKode();
  const { data, error } = await createAdminClient().rpc("email_skift_anmod", {
    p_bruger: bruger.id,
    p_ny: nyEmail,
    p_hash: hashEmailKode(bruger.id, kode),
  });
  const svar = (data ?? null) as { kode?: string; optaget?: boolean } | null;
  if (error || !svar?.kode) {
    await logDriftFejl({ kilde: "action", hvor: "emailSkift/anmod", fejl: error ?? "intet svar", brugerId: bruger.id });
    return { fejl: EMAIL_SKIFT.generisk, kode: "fejl" };
  }
  if (svar.kode === "ugyldig") return { fejl: EMAIL_SKIFT.ugyldigEmail, kode: "email" };
  if (svar.kode === "samme") return { fejl: EMAIL_SKIFT.samme, kode: "samme_email" };
  // En tidligere kode er netop godkendt, og Supabase Auth opdateres nu.
  if (svar.kode === "igang") return { fejl: EMAIL_SKIFT.igang, kode: "ikke_tilgaengelig" };
  const sp = spaerreFejl(svar.kode);
  if (sp) return sp;
  if (svar.kode !== "ok") return { fejl: EMAIL_SKIFT.generisk, kode: "fejl" };

  // Adressen er ledig: mailen sendes i baggrunden. I brug: ingen mail.
  // Svaret er det samme og kommer tidligst efter EMAIL_SKIFT_SVARTID.
  if (!svar.optaget) {
    after(async () => {
      try {
        const sendt = await sendHandelMailDetaljer(nyEmail, emailSkiftKodeMail({ kode, nyEmail }));
        if (!sendt.ok) {
          await logDriftFejl({ kilde: "action", hvor: "emailSkift/kodemail", fejl: sendt.fejl, brugerId: bruger.id });
        }
      } catch (err) {
        await logDriftFejl({ kilde: "action", hvor: "emailSkift/kodemail", fejl: err, brugerId: bruger.id });
      }
    });
  }
  await ventTil(start);
  return { ok: true, besked: EMAIL_SKIFT.kodeSendt };
}

// ------------------------------------------------------------ 2. Koden

export async function bekraeftEmailSkiftFor(args: {
  bruger: Pick<User, "id" | "email">;
  kode: unknown;
  // Logger andre enheder ud - denne bliver logget ind (som ved skift af
  // adgangskode): cookie-sessionen på hjemmesiden, Bearer-tokenet i appen.
  logUdAndre: () => Promise<AuthFejlInfo | null>;
}): Promise<{ ok: true; email: string } | EmailSkiftFejl> {
  const { bruger } = args;
  const kode = renEmailKode(args.kode);
  if (!kode) return { fejl: EMAIL_SKIFT.kodeFormat, kode: "kode_forkert" };

  const graense = await tjekGraenserLukket([["email_skift_kode_bruger", bruger.id]]);
  const graenseTekst = graenseFejl(graense);
  if (graenseTekst) return { fejl: graenseTekst, kode: graense === "for_mange" ? "for_mange" : "ikke_tilgaengelig" };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("email_skift_tjek", {
    p_bruger: bruger.id,
    p_hash: hashEmailKode(bruger.id, kode),
  });
  const svar = (data ?? null) as { kode?: string; id?: string; ny_email?: string; gammel_email?: string } | null;
  if (error || !svar?.kode) {
    await logDriftFejl({ kilde: "action", hvor: "emailSkift/tjek", fejl: error ?? "intet svar", brugerId: bruger.id });
    return { fejl: EMAIL_SKIFT.generisk, kode: "fejl" };
  }
  if (svar.kode === "forkert") return { fejl: EMAIL_SKIFT.kodeForkert, kode: "kode_forkert" };
  if (svar.kode === "for_mange") return { fejl: EMAIL_SKIFT.kodeForMange, kode: "kode_udloebet" };
  if (svar.kode === "udloebet" || svar.kode === "ingen") return { fejl: EMAIL_SKIFT.kodeUdloebet, kode: "kode_udloebet" };
  // Adressen er taget, efter koden blev sendt (den, der har koden, har adgang til adressen).
  if (svar.kode === "optaget") return { fejl: EMAIL_SKIFT.optaget, kode: "optaget" };
  const sp = spaerreFejl(svar.kode);
  if (sp) return sp;
  if (svar.kode !== "ok" || !svar.id || !svar.ny_email) return { fejl: EMAIL_SKIFT.generisk, kode: "fejl" };

  const nyEmail = svar.ny_email;
  const gammelEmail = bruger.email ?? svar.gammel_email ?? null;

  // Login-adressen skiftes nu. Databasen spejler i samme transaktion og
  // rydder gamle links/koder. Kaster kaldet (netværk, timeout), afsluttes
  // anmodningen som 'fejl', så den ikke sidder fast i 'bekraeftet'
  // (email_skift_anmod rydder også selv op efter 5 minutter).
  let authFejl: Awaited<ReturnType<typeof admin.auth.admin.updateUserById>>["error"];
  try {
    ({ error: authFejl } = await admin.auth.admin.updateUserById(bruger.id, { email: nyEmail, email_confirm: true }));
  } catch (err) {
    const { error: afslutFejl } = await admin.rpc("email_skift_afslut", { p_id: svar.id, p_status: "fejl" });
    await logDriftFejl({
      kilde: "action",
      hvor: "emailSkift/updateUserById",
      fejl: afslutFejl ? `${String(err)} (og email_skift_afslut: ${afslutFejl.message})` : err,
      brugerId: bruger.id,
    });
    return { fejl: EMAIL_SKIFT.generisk, kode: "fejl" };
  }
  if (authFejl) {
    // email_exists (422). Et kapløb lige her kan også give en 500 (unik
    // e-mail i databasen) - den logges som fejl, og intet er ændret.
    const optaget = authFejl.code === "email_exists" || authFejl.status === 422;
    await admin.rpc("email_skift_afslut", { p_id: svar.id, p_status: optaget ? "optaget" : "fejl" });
    if (optaget) return { fejl: EMAIL_SKIFT.optaget, kode: "optaget" };
    await logDriftFejl({
      kilde: "action",
      hvor: "emailSkift/updateUserById",
      fejl: `${authFejl.status ?? ""} ${authFejl.code ?? ""}: ${authFejl.message}`.replace(/[^\s@]+@[^\s@]+/g, "[e-mail]"),
      brugerId: bruger.id,
    });
    return { fejl: EMAIL_SKIFT.generisk, kode: "fejl" };
  }
  await nulstilGraense("email_skift_kode_bruger", bruger.id);

  // Andre enheder logges ud - denne bliver logget ind.
  const udFejl = await args.logUdAndre();
  if (udFejl) {
    await logDriftFejl({
      kilde: "action",
      hvor: "emailSkift/logUdAndre",
      fejl: `${udFejl.status ?? ""} ${udFejl.code ?? ""}: ${udFejl.message ?? ""}`,
      brugerId: bruger.id,
    });
  }

  // Den gamle adresse får besked (med "Var det ikke dig?").
  if (gammelEmail) {
    const res = await sendHandelMailDetaljer(gammelEmail, emailAendretMail({ tidspunkt: new Date(), nyEmail }));
    if (!res.ok) await logDriftFejl({ kilde: "action", hvor: "emailSkift/mail-gammel", fejl: res.fejl, brugerId: bruger.id });
  }

  await synkEmailTilStripe(bruger.id, nyEmail);
  return { ok: true, email: nyEmail };
}

// Den private Stripe-kunde (kvitteringer, gemt kort) får den nye adresse.
// Connect-kontoen opdateres kun, hvis BidHamr styrer den (ikke Express): på
// en Express-konto er e-mailen sælgerens eget login til Stripe, som sælgeren
// selv retter i Stripe - det springes over og logges som info. Andre fejl
// stopper ikke skiftet - de logges i /admin/drift. Firmaets Stripe-kunde (firmaer.stripe_customer_id) følger
// med via kontakt_email og cron'en (firmaer_stripe_kunde_aendret).
// Alle kald går gennem getStripe() og dens tilstandsvagt (src/lib/stripe.ts),
// så nøgle og database altid er i samme Stripe-tilstand (testmiljøet indtil
// fase 6).
export async function synkEmailTilStripe(brugerId: string, email: string): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const { data: profil, error } = await createAdminClient()
    .from("betalingsprofiler")
    .select("stripe_customer_id, stripe_account_id, connect_frakoblet_kl")
    .eq("user_id", brugerId)
    .maybeSingle<{ stripe_customer_id: string | null; stripe_account_id: string | null; connect_frakoblet_kl: string | null }>();
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: "emailSkift/stripe", fejl: error, brugerId });
    return;
  }
  if (!profil) return;
  if (profil.stripe_customer_id) {
    try {
      await getStripe().customers.update(profil.stripe_customer_id, { email });
    } catch (err) {
      await logDriftFejl({ kilde: "server", hvor: "emailSkift/stripe-kunde", fejl: err, brugerId });
    }
  }
  if (profil.stripe_account_id && !profil.connect_frakoblet_kl) {
    try {
      const konto = await getStripe().accounts.retrieve(profil.stripe_account_id);
      if (konto.type === "express" || konto.controller?.requirement_collection === "stripe") {
        console.info("emailSkift: Connect-kontoen er en Express-konto - e-mailen rettes af sælgeren i Stripe.");
        return;
      }
      await getStripe().accounts.update(profil.stripe_account_id, { email });
    } catch (err) {
      await logDriftFejl({ kilde: "server", hvor: "emailSkift/stripe-connect", fejl: err, brugerId });
    }
  }
}
