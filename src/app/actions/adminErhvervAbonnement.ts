"use server";

// Admin -> Erhverv -> Firma: hurtighandlinger på abonnementet (Filip, 26. okt.
// 2026 - "Sælger-rollen kan lige så meget som chefen på firmasiden"). Chef OG
// sælger-rollen (assertErhverv() uden kun-chef) - databasen tjekker det samme
// (erhverv_har_adgang i hver staff-RPC, som kun service_role kan kalde).
// Admin og medarbejder har ingen adgang.
//
// Alle handlinger kræver en begrundelse (3-500 tegn) og logges med navn i
// moderation_log af databasen. Firmaet får en mail ved ændring af pakke,
// pris, rabat og gratis periode (FIRMA_ABONNEMENT_MAIL). Stripe ændres FØRST
// (src/lib/erhverv/betaling.ts) - databasen spejler bagefter.
//
// Svar: { ok: true, besked } | { fejl } (som resten af adminErhverv).

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertErhverv } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { FOR_MANGE_FORSOEG, indenForGraense } from "@/lib/rateLimit";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { firmaAbonnementMail } from "@/lib/mails/erhverv";
import {
  fjernIntroStripe,
  frigivPakkeskiftLaas,
  givGratisPeriodeStripe,
  introTilStripe,
  refunderRegningStripe,
  saetSaerprisStripe,
  saetSaerprisTilbage,
  type AbonnementHandlingSvar,
} from "@/lib/erhverv/betaling";
import { GRATIS_MAANEDER_MAKS, INTRO_GRAENSER, gyldigBegrundelse, type IntroFra } from "@/lib/erhverv/abonnementRegler";
import { kr, krFraOere, langDato } from "@/lib/erhverv/visning";
import { ADMIN_FIRMA_ABONNEMENT as T, FIRMA_ABONNEMENT_MAIL as M } from "@/lib/tekster/erhverv";
import { opdaterFirma } from "@/app/actions/adminErhverv";

class BrugerFejl extends Error {}

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Svar = { ok: true; besked: string } | { fejl: string };
type Admin = Awaited<ReturnType<typeof assertErhverv>>["admin"];

async function koer(navn: string, fn: () => Promise<Svar>): Promise<Svar> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Du har ikke adgang til Erhverv." };
    }
    console.error(`Erhverv-handling ${navn} fejlede:`, err);
    await logDriftFejl({ kilde: "action", hvor: `adminErhvervAbonnement.${navn}`, fejl: err });
    return { fejl: GENERISK };
  }
}

function tjekUuid(v: unknown): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new BrugerFejl("Ugyldigt id.");
  return v;
}

function tjekBegrundelse(v: unknown): string {
  const b = gyldigBegrundelse(v);
  if (!b) throw new BrugerFejl(T.begrundelse);
  return b;
}

async function adgang(): Promise<{ admin: Admin; userId: string }> {
  const a = await assertErhverv();
  if (!(await indenForGraense("erhverv_abonnement_staff", a.userId))) throw new BrugerFejl(FOR_MANGE_FORSOEG);
  return a;
}

type FirmaInfo = {
  id: string;
  bruger_id: string;
  firmanavn: string;
  kontakt_email: string;
  pakke_id: string;
  stripe_subscription_id: string | null;
  intro_procent: number | null;
  intro_maaneder: number | null;
  intro_fra: IntroFra | null;
  proeve_slut: string | null;
};

async function hentFirma(admin: Admin, firmaId: string): Promise<FirmaInfo> {
  const { data, error } = await admin
    .from("firmaer")
    .select("id, bruger_id, firmanavn, kontakt_email, pakke_id, stripe_subscription_id, intro_procent, intro_maaneder, intro_fra, proeve_slut")
    .eq("id", firmaId)
    .maybeSingle<FirmaInfo>();
  if (error) throw new Error(error.message);
  if (!data) throw new BrugerFejl(T.firmaFindesIkke);
  return data;
}

async function pakke(admin: Admin, pakkeId: string): Promise<{ navn: string; maanedspris: number | null }> {
  const { data, error } = await admin
    .from("erhverv_pakker")
    .select("navn, maanedspris")
    .eq("id", pakkeId)
    .maybeSingle<{ navn: string; maanedspris: number | string | null }>();
  if (error) throw new Error(error.message);
  return { navn: data?.navn ?? "?", maanedspris: data?.maanedspris == null ? null : Number(data.maanedspris) };
}

// Databasens svarkoder -> dansk tekst. Ukendt kode = generisk fejl.
const DB_FEJL: Record<string, string> = {
  begrundelse: T.begrundelse,
  ikke_fundet: T.firmaFindesIkke,
  ugyldigt_antal: T.ekstra.ugyldig,
  under_nul: T.ekstra.underNul,
  ugyldig_rabat: T.intro.ugyldig,
  ugyldig_pris: T.saerpris.ugyldig,
  pakke_skiftet: T.saerpris.pakkeSkiftet,
  for_lang: T.gratis.forLang,
  allerede: "Det er allerede gjort. Opdater siden.",
};

async function rpc(admin: Admin, navn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc(navn, args);
  if (error) throw new Error(`${navn}: ${error.message}`);
  const svar = (data ?? {}) as Record<string, unknown>;
  const kode = String(svar.kode ?? "");
  if (kode !== "ok") throw kode && DB_FEJL[kode] ? new BrugerFejl(DB_FEJL[kode]) : new Error(`${navn}: ${kode || "intet svar"}`);
  return svar;
}

// Stripe afviste ændringen (opsagt, pakkeskift venter ...) eller fejlede.
function stripeAfvist(svar: AbonnementHandlingSvar, stripeFejlTekst = GENERISK): never {
  if (svar.status === "afvist") throw new BrugerFejl(svar.fejl);
  if (svar.status === "fejl") throw new Error(svar.fejl);
  throw new BrugerFejl(stripeFejlTekst);
}

// Mail til firmaets kontakt-e-mail. Fejler den, er handlingen stadig gjort -
// staff får besked og der logges en drift-alarm.
async function sendMail(f: FirmaInfo, mail: Parameters<typeof firmaAbonnementMail>[0], staffId: string): Promise<boolean> {
  const sendt = await sendHandelMailDetaljer(f.kontakt_email, firmaAbonnementMail(mail));
  if (!sendt.ok) {
    await logDriftFejl({ kilde: "action", hvor: "adminErhvervAbonnement.mail", fejl: `Firma ${f.id}: ${sendt.fejl}`, brugerId: staffId });
  }
  return sendt.ok;
}

function medMail(besked: string, sendt: boolean): string {
  return sendt ? besked : `${besked} ${T.mailIkkeSendt}`;
}

function dato(iso: string | null | undefined): string | null {
  return iso ? langDato(iso) : null;
}

// --- Gratis periode -------------------------------------------------------------

// +1-3 gratis måneder. Har firmaet et abonnement, forlænges den gratis periode
// i Stripe (trial_end) - eller de gratis måneder lægges efter den betalte
// periode. Ellers gælder de, når firmaet starter abonnementet.
export async function givFirmaGratisPeriode(input: { firmaId: string; maaneder: number; begrundelse: string }): Promise<Svar> {
  return koer("givFirmaGratisPeriode", async () => {
    const { admin, userId } = await adgang();
    const firmaId = tjekUuid(input?.firmaId);
    const maaneder = input.maaneder;
    if (!Number.isInteger(maaneder) || maaneder < 1 || maaneder > GRATIS_MAANEDER_MAKS) throw new BrugerFejl(T.gratis.ugyldig);
    const begrundelse = tjekBegrundelse(input.begrundelse);
    const f = await hentFirma(admin, firmaId);

    const stripeSvar = await givGratisPeriodeStripe(firmaId, maaneder);
    if (stripeSvar.status !== "ok" && stripeSvar.status !== "ingen_stripe") stripeAfvist(stripeSvar);
    const iStripe = stripeSvar.status === "ok";
    const til = iStripe ? (stripeSvar.proeveSlut ?? null) : null;
    try {
      await rpc(admin, "erhverv_firma_gratis_gem", {
        p_staff: userId,
        p_firma: firmaId,
        p_maaneder: maaneder,
        p_begrundelse: begrundelse,
        p_stripe: iStripe,
        p_proeve_slut: til,
      });
    } catch (err) {
      // Stripe ER ændret: spejlet fanges af webhooken (customer.subscription.updated);
      // loggen mangler - alarm, så det kan skrives på.
      if (iStripe) {
        await logDriftFejl({
          kilde: "action",
          hvor: "adminErhvervAbonnement.gratis-log",
          fejl: `Firma ${firmaId} har fået ${maaneder} gratis måned(er) i Stripe (til ${til}), men det kunne ikke logges: ${String(err)}`,
          brugerId: userId,
        });
      }
      throw err;
    }
    const sendt = await sendMail(
      f,
      { emne: M.gratis.emne, overskrift: M.gratis.overskrift, afsnit: M.gratis.tekst(f.firmanavn, maaneder, dato(til)) },
      userId,
    );
    revalidatePath("/admin/erhverv");
    return { ok: true, besked: medMail(T.gratis.givet(maaneder, dato(til)), sendt) };
  });
}

// --- Introrabat -------------------------------------------------------------------

// X % i N måneder. fra 'efter_gratis' (standard): N betalte måneder efter den
// gratis periode. 'straks': N måneder fra nu (en gratis periode bruger af dem).
export async function saetFirmaIntrorabat(input: {
  firmaId: string;
  procent: number;
  maaneder: number;
  fra?: IntroFra;
  begrundelse: string;
}): Promise<Svar> {
  return koer("saetFirmaIntrorabat", async () => {
    const { admin, userId } = await adgang();
    const firmaId = tjekUuid(input?.firmaId);
    const { procent, maaneder } = input;
    const fra: IntroFra = input.fra === "straks" ? "straks" : "efter_gratis";
    if (
      !Number.isInteger(procent) || procent < INTRO_GRAENSER.procentMin || procent > INTRO_GRAENSER.procentMaks ||
      !Number.isInteger(maaneder) || maaneder < INTRO_GRAENSER.maanederMin || maaneder > INTRO_GRAENSER.maanederMaks
    ) {
      throw new BrugerFejl(T.intro.ugyldig);
    }
    const begrundelse = tjekBegrundelse(input.begrundelse);
    const f = await hentFirma(admin, firmaId);

    // Aftalen gemmes ('planlagt'), og Stripe-delen sætter kuponen på. Fejler
    // Stripe, prøver betalings-cron'en igen (koerAbonnementSynk) - aftalen
    // går ikke tabt.
    await rpc(admin, "erhverv_firma_intro_gem", {
      p_staff: userId,
      p_firma: firmaId,
      p_procent: procent,
      p_maaneder: maaneder,
      p_fra: fra,
      p_begrundelse: begrundelse,
    });
    const stripeSvar = await introTilStripe(firmaId);
    let besked: string;
    if (stripeSvar.status === "ok") besked = T.intro.sat(procent, maaneder, true);
    else if (stripeSvar.status === "ingen_stripe") besked = T.intro.sat(procent, maaneder, false);
    else {
      if (stripeSvar.status === "fejl") {
        await logDriftFejl({ kilde: "action", hvor: "adminErhvervAbonnement.intro", fejl: `Firma ${firmaId}: ${stripeSvar.fejl}`, brugerId: userId });
      }
      besked = stripeSvar.status === "afvist" ? `${T.intro.venter} (${stripeSvar.fejl})` : T.intro.venter;
    }
    const sendt = await sendMail(
      f,
      { emne: M.intro.emne, overskrift: M.intro.overskrift, afsnit: M.intro.tekst(f.firmanavn, procent, maaneder, fra === "efter_gratis") },
      userId,
    );
    revalidatePath("/admin/erhverv");
    return { ok: true, besked: medMail(besked, sendt) };
  });
}

export async function fjernFirmaIntrorabat(input: { firmaId: string; begrundelse: string }): Promise<Svar> {
  return koer("fjernFirmaIntrorabat", async () => {
    const { admin, userId } = await adgang();
    const firmaId = tjekUuid(input?.firmaId);
    const begrundelse = tjekBegrundelse(input.begrundelse);
    const f = await hentFirma(admin, firmaId);
    if (f.intro_procent == null) throw new BrugerFejl(T.intro.ingen);
    const stripeSvar = await fjernIntroStripe(firmaId);
    if (stripeSvar.status !== "ok" && stripeSvar.status !== "ingen_stripe") stripeAfvist(stripeSvar);
    await rpc(admin, "erhverv_firma_intro_gem", {
      p_staff: userId,
      p_firma: firmaId,
      p_procent: null,
      p_maaneder: null,
      p_fra: null,
      p_begrundelse: begrundelse,
    });
    const sendt = await sendMail(
      f,
      { emne: M.intro.fjernetEmne, overskrift: M.intro.fjernetOverskrift, afsnit: M.intro.fjernetTekst(f.firmanavn) },
      userId,
    );
    revalidatePath("/admin/erhverv");
    return { ok: true, besked: medMail(T.intro.fjernet, sendt) };
  });
}

// --- Særpris ------------------------------------------------------------------------

// Fast månedspris ekskl. moms (hele kroner) for firmaets nuværende pakke, eller
// null = pakkens almindelige pris igen. fra 'naeste_betaling' (standard) eller
// 'straks' (forskellen for resten af perioden kommer på næste regning).
// aftale = begrundelsen (fx "Aftalt med Hans 26/10: 2 års binding").
export async function saetFirmaSaerpris(input: {
  firmaId: string;
  maanedsprisEksklMoms: number | null;
  fra?: "naeste_betaling" | "straks";
  aftale: string;
}): Promise<Svar> {
  return koer("saetFirmaSaerpris", async () => {
    const { admin, userId } = await adgang();
    const firmaId = tjekUuid(input?.firmaId);
    const pris = input.maanedsprisEksklMoms;
    if (pris !== null && (!Number.isInteger(pris) || pris < 1 || pris > 1_000_000)) throw new BrugerFejl(T.saerpris.ugyldig);
    const fra = input.fra === "straks" ? "straks" : "naeste_betaling";
    const aftale = tjekBegrundelse(input.aftale);
    const f = await hentFirma(admin, firmaId);
    const oere = pris === null ? null : pris * 100;

    const stripeSvar = await saetSaerprisStripe(firmaId, f.pakke_id, oere, fra);
    if (stripeSvar.status !== "ok" && stripeSvar.status !== "ingen_stripe") {
      if (stripeSvar.status === "fejl") {
        await logDriftFejl({ kilde: "action", hvor: "adminErhvervAbonnement.saerpris", fejl: `Firma ${firmaId}: ${stripeSvar.fejl}`, brugerId: userId });
        throw new BrugerFejl(T.saerpris.stripeFejl);
      }
      stripeAfvist(stripeSvar);
    }
    try {
      await rpc(admin, "erhverv_firma_saerpris_gem", {
        p_staff: userId,
        p_firma: firmaId,
        p_oere: oere,
        p_pakke: f.pakke_id,
        p_aftale: aftale,
        p_fra: fra,
      });
    } catch (err) {
      if (stripeSvar.status === "ok") await saetSaerprisTilbage(stripeSvar, firmaId);
      throw err;
    } finally {
      if (stripeSvar.status === "ok") await frigivPakkeskiftLaas(firmaId, stripeSvar.laas);
    }
    const p = await pakke(admin, f.pakke_id);
    const sendt = await sendMail(
      f,
      oere === null
        ? {
            emne: M.saerpris.emne,
            overskrift: M.saerpris.overskrift,
            afsnit: M.saerpris.fjernetTekst(f.firmanavn, p.navn, kr(p.maanedspris ?? 0)),
          }
        : {
            emne: M.saerpris.emne,
            overskrift: M.saerpris.overskrift,
            afsnit: M.saerpris.tekst(f.firmanavn, p.navn, kr(pris!), fra === "straks"),
          },
      userId,
    );
    revalidatePath("/admin/erhverv");
    return {
      ok: true,
      besked: medMail(oere === null ? T.saerpris.fjernet : T.saerpris.sat(kr(pris!), stripeSvar.status === "ok"), sendt),
    };
  });
}

// --- Ekstra auktioner og fremhævninger (indeværende måned) -------------------------

async function givEkstra(
  navn: string,
  input: { firmaId: string; antal: number; begrundelse: string },
  hvad: "auktioner" | "fremhaevninger",
): Promise<Svar> {
  return koer(navn, async () => {
    const { admin, userId } = await adgang();
    const firmaId = tjekUuid(input?.firmaId);
    const antal = input.antal;
    const maks = hvad === "auktioner" ? 1000 : 100;
    if (!Number.isInteger(antal) || antal === 0 || Math.abs(antal) > maks) throw new BrugerFejl(T.ekstra.ugyldig);
    const begrundelse = tjekBegrundelse(input.begrundelse);
    const svar = await rpc(admin, "erhverv_firma_ekstra_giv", {
      p_staff: userId,
      p_firma: firmaId,
      p_auktioner: hvad === "auktioner" ? antal : 0,
      p_fremhaevninger: hvad === "fremhaevninger" ? antal : 0,
      p_begrundelse: begrundelse,
    });
    revalidatePath("/admin/erhverv");
    const iAlt = Number(svar[hvad] ?? 0);
    return { ok: true, besked: hvad === "auktioner" ? T.ekstra.auktioner(iAlt) : T.ekstra.fremhaevninger(iAlt) };
  });
}

// antal: lægges til månedens ekstra (et negativt tal trækker fra, aldrig under 0).
export async function givFirmaEkstraAuktioner(input: { firmaId: string; antal: number; begrundelse: string }): Promise<Svar> {
  return givEkstra("givFirmaEkstraAuktioner", input, "auktioner");
}

export async function givFirmaEkstraFremhaevninger(input: { firmaId: string; antal: number; begrundelse: string }): Promise<Svar> {
  return givEkstra("givFirmaEkstraFremhaevninger", input, "fremhaevninger");
}

// --- Skift pakke (med det samme) ------------------------------------------------------

// Pakken skifter med det samme (flere auktioner med det samme); prisen i
// Stripe skifter fra firmaets næste betaling (opdaterFirma -> skiftPrisAdmin,
// proration 'none'). En særpris for den gamle pakke bortfalder. Mail til firmaet.
export async function skiftFirmaPakkeAdmin(input: { firmaId: string; pakkeId: string; begrundelse: string }): Promise<Svar> {
  return koer("skiftFirmaPakkeAdmin", async () => {
    const { admin, userId } = await adgang();
    const firmaId = tjekUuid(input?.firmaId);
    const pakkeId = tjekUuid(input?.pakkeId);
    const begrundelse = tjekBegrundelse(input.begrundelse);
    const f = await hentFirma(admin, firmaId);
    if (f.pakke_id === pakkeId) throw new BrugerFejl(T.pakke.uaendret);
    const [fra, til] = await Promise.all([pakke(admin, f.pakke_id), pakke(admin, pakkeId)]);
    const svar = await opdaterFirma({ firmaId, pakkeId, note: begrundelse });
    if ("fejl" in svar) return { fejl: svar.fejl };
    const sendt = await sendMail(
      f,
      { emne: M.pakke.emne, overskrift: M.pakke.overskrift, afsnit: M.pakke.tekst(f.firmanavn, fra.navn, til.navn, kr(til.maanedspris ?? 0)) },
      userId,
    );
    return { ok: true, besked: medMail(T.pakke.skiftet(til.navn), sendt) };
  });
}

// --- Kort -------------------------------------------------------------------------------

// Mail til firmaet om at skifte betalingskort (link til Firma oversigt ->
// Abonnement -> "Skift betalingskort", som åbner Stripes kundeportal).
export async function sendFirmaNytKortMail(firmaId: string): Promise<Svar> {
  return koer("sendFirmaNytKortMail", async () => {
    const { admin, userId } = await adgang();
    const id = tjekUuid(firmaId);
    const f = await hentFirma(admin, id);
    if (!(await indenForGraense("erhverv_kort_mail", id))) throw new BrugerFejl(FOR_MANGE_FORSOEG);
    const { data: k } = await admin
      .from("firmaer")
      .select("kort_maerke, kort_sidste4, kort_udloeb_maaned, kort_udloeb_aar")
      .eq("id", id)
      .maybeSingle<{ kort_maerke: string | null; kort_sidste4: string | null; kort_udloeb_maaned: number | null; kort_udloeb_aar: number | null }>();
    const kort = k?.kort_sidste4
      ? `${k.kort_maerke ? `${k.kort_maerke.toUpperCase()} ` : ""}•••• ${k.kort_sidste4}${
          k.kort_udloeb_maaned && k.kort_udloeb_aar ? `, udløber ${String(k.kort_udloeb_maaned).padStart(2, "0")}/${String(k.kort_udloeb_aar).slice(-2)}` : ""
        }`
      : null;
    const sendt = await sendMail(
      f,
      { emne: M.kort.emne, overskrift: M.kort.overskrift, afsnit: M.kort.tekst(f.firmanavn, kort), knap: M.kort.knap },
      userId,
    );
    if (!sendt) throw new BrugerFejl(T.kortMail.fejl);
    const { error } = await admin.rpc("erhverv_firma_log", {
      p_staff: userId,
      p_firma: id,
      p_handling: "firma_kort_mail",
      p_tekst: `Mail om nyt betalingskort sendt til ${f.kontakt_email}`,
    });
    if (error) await logDriftFejl({ kilde: "action", hvor: "sendFirmaNytKortMail/log", fejl: error, brugerId: userId });
    return { ok: true, besked: T.kortMail.sendt };
  });
}

// --- Refusion af en regning --------------------------------------------------------------

// Hel refusion (ingen delvis) af en betalt abonnements- eller opgraderingsregning
// med kreditnota i Stripe. Chef og sælger-rollen. Abonnementet fortsætter.
export async function refunderFirmaRegning(input: { regningId: string; begrundelse: string }): Promise<Svar> {
  return koer("refunderFirmaRegning", async () => {
    const { admin, userId } = await adgang();
    const regningId = tjekUuid(input?.regningId);
    const begrundelse = tjekBegrundelse(input.begrundelse);
    const svar = await refunderRegningStripe(regningId);
    if (svar.status === "afvist") throw new BrugerFejl(svar.fejl);
    if (svar.status === "fejl") throw new Error(svar.fejl);
    const { error } = await admin.rpc("erhverv_firma_log", {
      p_staff: userId,
      p_firma: svar.firmaId,
      p_handling: "firma_regning_refunderet",
      p_tekst: `Regning refunderet (${krFraOere(svar.beloebOere)} inkl. moms, kreditnota i Stripe): ${begrundelse}`,
    });
    if (error) {
      await logDriftFejl({
        kilde: "action",
        hvor: "refunderFirmaRegning/log",
        fejl: `Regning ${regningId} ER refunderet, men det kunne ikke logges: ${error.message}`,
        brugerId: userId,
      });
    }
    revalidatePath("/admin/erhverv");
    return { ok: true, besked: T.refusion.refunderet(krFraOere(svar.beloebOere)) };
  });
}

// --- Fremhævninger --------------------------------------------------------------------------

// Stop en fremhævning (fx forkert auktion). tilbage: giv den tilbage til
// månedens kvote.
export async function stopFirmaFremhaevning(input: { id: string; tilbage: boolean; begrundelse: string }): Promise<Svar> {
  return koer("stopFirmaFremhaevning", async () => {
    const { admin, userId } = await adgang();
    const id = tjekUuid(input?.id);
    const begrundelse = tjekBegrundelse(input.begrundelse);
    await rpc(admin, "erhverv_fremhaevning_stop", {
      p_staff: userId,
      p_id: id,
      p_tilbage: input.tilbage === true,
      p_begrundelse: begrundelse,
    });
    revalidatePath("/admin/erhverv");
    return { ok: true, besked: input.tilbage ? T.fremhaevning.tilbage : T.fremhaevning.stoppet };
  });
}
