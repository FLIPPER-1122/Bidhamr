"use server";

// Admin → Erhverv (kun chef og sælger). Chef og sælger må alt ved firmaer
// (Filip, 10. okt. 2026) - også pakke, status, firmanavn, CVR og opsigelse.
// Kun pakkerne selv (oprette/ændre pakker og priser) er kun chef.
// Adgangen tjekkes her (assertErhverv) OG i databasen (erhverv_har_adgang i
// hver staff-RPC, som kun service_role kan kalde). Alle ændringer logges i
// moderation_log af databasen. Fejl RETURNERES som { fejl }.
//
// Firmakonto: BidHamr opretter den - et firma kan aldrig oprette sig selv.
// opretFirmakonto laver en NY auth-bruger med firmaets e-mail
// (generateLink 'invite' - Supabase sender ingen mail), gør den til
// firmakonto (erhverv_firma_opret) og sender vores egen velkomstmail med et
// engangslink til "Vælg din adgangskode". Har e-mailen allerede en konto,
// afvises det: så skal staff bruge en anden e-mail.

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertErhverv } from "@/lib/adminAuth";
import { FOR_MANGE_FORSOEG, indenForGraense } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { fjernBillet, fjernBilletFraMetadata, nyBillet } from "@/lib/kontoOprettelse";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { firmaVelkomstMail } from "@/lib/mails/erhverv";
import { sideUrl } from "@/lib/mails/layout";
import { cvrTilOprettelse, slaaCvrOpOffentligt, type CvrOpslag } from "@/lib/erhverv/cvr";
import { udstedVelkomstBillet, VELKOMST_TIMER } from "@/lib/erhverv/velkomstBillet";
import {
  fortrydOpsigelse,
  opsigAbonnement,
  saetAdminPrisTilbage,
  sikrPris,
  skiftPrisAdmin,
  PakkeskiftIGang,
  frigivPakkeskiftLaas,
  startAbonnement,
  stripeTilgaengelig,
  type AdminPrisSvar,
} from "@/lib/erhverv/betaling";
import { ADMIN_ERHVERV, ADMIN_ERHVERV_BETALING as AB } from "@/lib/tekster/erhverv";
import {
  EMAIL,
  ERHVERV_GRAENSER as G,
  POSTNUMMER,
  erAbonnementStatus,
  erHenvendelseStatus,
  renCvr,
  renTelefon,
  type AbonnementStatus,
  type ErhvervPakke,
  type FirmaAbonnement,
  type HenvendelseStatus,
} from "@/lib/erhverv/regler";

class BrugerFejl extends Error {}

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function koer<T>(navn: string, fn: () => Promise<T>): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Du har ikke adgang til Erhverv." };
    }
    console.error(`Erhverv-handling ${navn} fejlede:`, err);
    await logDriftFejl({ kilde: "action", hvor: `adminErhverv.${navn}`, fejl: err });
    return { fejl: GENERISK };
  }
}

function tjekUuid(id: unknown, tekst = "Ugyldigt id."): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new BrugerFejl(tekst);
  return id;
}

function tekstFelt(v: unknown, maks: number, fejl: string, paakraevet = true): string | null {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s) {
    if (paakraevet) throw new BrugerFejl(fejl);
    return null;
  }
  if (s.length > maks) throw new BrugerFejl(fejl);
  return s;
}

const KODE_FEJL: Record<string, string> = {
  ikke_fundet: "Findes ikke længere. Opdater siden.",
  ugyldig_status: "Ugyldig status.",
  for_lang_note: `Noterne må højst være ${G.noter.toLocaleString("da-DK")} tegn.`,
  ugyldigt_navn: `Pakkens navn skal være 1-${G.pakkeNavn} tegn.`,
  ugyldig_beskrivelse: `Beskrivelsen må højst være ${G.pakkeBeskrivelse} tegn.`,
  ugyldig_pris: "Prisen skal være et helt antal kroner (eller tom, hvis den ikke er sat).",
  ugyldigt_antal: `Antal auktioner pr. måned skal være mellem 1 og ${G.auktionerPrMaanedMaks} (eller ubegrænset).`,
  ugyldige_fremhaevninger: "Antal fremhævninger pr. måned skal være mellem 0 og 1000.",
  ugyldig_statistik: "Vælg statistik: ingen, statistik eller fuld.",
  arkiveret: "Pakken er arkiveret og kan ikke ændres.",
  navn_findes: "Der findes allerede en pakke med det navn.",
  ugyldig_rabat: "Rabatten på Ugens butik skal være 0-90 % og 0-52 uger pr. år - udfyld begge eller ingen af dem.",
  bruger_findes_ikke: "Kontoen kunne ikke oprettes. Prøv igen.",
  ikke_ny_konto: "E-mailen har allerede en konto hos BidHamr. Brug en anden e-mail til firmakontoen.",
  ugyldigt_cvr: "CVR-nummeret skal have 8 cifre.",
  cvr_findes: "Der findes allerede en aktiv firmakonto med det CVR-nummer.",
  // Samme tekst som formularen viser efter "Slå CVR op".
  cvr_ikke_aktivt: ADMIN_ERHVERV.opret.fejl.cvrIkkeAktivt,
  cvr_ikke_fundet: "CVR-nummeret findes ikke i CVR-registret. Tjek nummeret. Kontoen kan ikke oprettes.",
  cvr_tidligere: "CVR'et har haft et abonnement før. Prøv igen, og bekræft, at kontoen skal oprettes alligevel.",
  ugyldig_pakke: "Vælg en pakke (arkiverede pakker kan ikke vælges).",
  ugyldig_rabat_intro: "Introrabatten skal være 1-100 % i 1-24 måneder - udfyld begge eller ingen af dem.",
  henvendelse_findes_ikke: "Henvendelsen findes ikke længere.",
  henvendelse_brugt: "Der er allerede oprettet en firmakonto ud fra denne henvendelse.",
  ugyldige_felter: "Tjek felterne og prøv igen.",
  kun_chef: "Kun chefen kan ændre pakke, status, firmanavn og CVR. Du kan rette adresse og kontaktoplysninger.",
};

function kodeFejl(kode: string | undefined): never {
  throw new BrugerFejl((kode && KODE_FEJL[kode]) || GENERISK);
}

// --- Henvendelser -------------------------------------------------------------

export type ErhvervHenvendelse = {
  id: string;
  firmanavn: string;
  cvr: string;
  kontaktperson: string;
  telefon: string;
  email: string;
  adresse: string | null;
  postnummer: string | null;
  bynavn: string | null;
  hvad_saelger_i: string;
  antal_varer_ca: number | null;
  besked: string | null;
  status: HenvendelseStatus;
  noter: string | null;
  behandlet_af: string | null;
  behandlet_af_navn: string | null;
  behandlet_kl: string | null;
  bruger_id: string | null;
  arkiveret_kl: string | null;
  oprettet_kl: string;
  opdateret_kl: string;
  firma_id: string | null;
};

export async function hentErhvervHenvendelser(filter?: {
  status?: HenvendelseStatus | null;
  arkiverede?: boolean;
}) {
  return koer("hentErhvervHenvendelser", async () => {
    const { admin, userId } = await assertErhverv();
    const status = filter?.status && erHenvendelseStatus(filter.status) ? filter.status : null;
    const { data, error } = await admin.rpc("erhverv_henvendelser_liste", {
      p_staff: userId,
      p_status: status,
      p_arkiverede: filter?.arkiverede === true,
    });
    if (error) throw new Error(error.message);
    return { ok: true as const, henvendelser: (data ?? []) as ErhvervHenvendelse[] };
  });
}

// Antal nye (til menuens tæller).
export async function hentAntalNyeErhvervHenvendelser() {
  return koer("hentAntalNyeErhvervHenvendelser", async () => {
    const { admin } = await assertErhverv();
    const { count, error } = await admin
      .from("erhverv_henvendelser")
      .select("id", { count: "exact", head: true })
      .eq("status", "ny")
      .is("arkiveret_kl", null);
    if (error) throw new Error(error.message);
    return { ok: true as const, antal: count ?? 0 };
  });
}

// null/udeladt = uændret. arkiver: true arkiverer, false henter tilbage.
export async function opdaterErhvervHenvendelse(input: {
  id: string;
  status?: HenvendelseStatus | null;
  noter?: string | null;
  arkiver?: boolean | null;
}) {
  return koer("opdaterErhvervHenvendelse", async () => {
    const { admin, userId } = await assertErhverv();
    const id = tjekUuid(input?.id);
    if (input.status != null && !erHenvendelseStatus(input.status)) throw new BrugerFejl("Ugyldig status.");
    if (typeof input.noter === "string" && input.noter.length > G.noter) kodeFejl("for_lang_note");
    const { data, error } = await admin.rpc("erhverv_henvendelse_opdater", {
      p_staff: userId,
      p_id: id,
      p_status: input.status ?? null,
      p_noter: typeof input.noter === "string" ? input.noter : null,
      p_arkiver: typeof input.arkiver === "boolean" ? input.arkiver : null,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") kodeFejl(kode);
    revalidatePath("/admin/erhverv");
    return { ok: true as const };
  });
}

// --- Pakker ---------------------------------------------------------------------

// auktioner_pr_uge: KUN for de gamle admin-komponenter (pakke-editor og
// "Skift pakke"), der endnu viser ét tal - her er det auktioner pr. MÅNED,
// 0 = ubegrænset. Nye komponenter skal bruge auktioner_pr_maaned/ubegraenset.
export type ErhvervPakkeAdmin = Omit<ErhvervPakke, "auktioner_pr_uge"> & {
  auktioner_pr_uge: number;
  sortering: number;
  antal_firmaer: number;
};

export async function hentErhvervPakker() {
  return koer("hentErhvervPakker", async () => {
    const { admin, userId } = await assertErhverv();
    const { data, error } = await admin.rpc("erhverv_pakker_liste", { p_staff: userId });
    if (error) throw new Error(error.message);
    const pakker = ((data ?? []) as (ErhvervPakke & { sortering: number; antal_firmaer: number })[]).map(
      (p): ErhvervPakkeAdmin => ({ ...p, auktioner_pr_uge: p.auktioner_pr_maaned ?? (p.ubegraenset ? 0 : (p.auktioner_pr_uge ?? 0)) }),
    );
    return { ok: true as const, pakker };
  });
}

// Kun chef. id udeladt = ny pakke. maanedspris null = ikke sat endnu.
// ugensButikRabatProcent/-Antal: pakkens rabat på Ugens butik (fx Butik 50 %
// de første 3 uger pr. kalenderår); begge udeladt = uændret (ny pakke: ingen
// rabat). Databasen tjekker og logger (20261101060000).
export async function gemErhvervPakke(input: {
  id?: string | null;
  navn: string;
  beskrivelse?: string | null;
  maanedspris: number | null;
  // Auktioner pr. kalendermåned; null = ubegrænset. (auktionerPrUge er det
  // gamle navn fra pakke-editoren og læses som auktioner pr. måned.)
  auktionerPrMaaned?: number | null;
  auktionerPrUge?: number;
  fremhaevningerPrMaaned?: number | null;
  statistik?: "ingen" | "statistik" | "fuld" | null;
  fastKontaktperson?: boolean | null;
  aktiv?: boolean;
  sortering?: number;
  ugensButikRabatProcent?: number | null;
  ugensButikRabatAntal?: number | null;
}) {
  return koer("gemErhvervPakke", async () => {
    const { admin, userId } = await assertErhverv(true);
    const id = input?.id ? tjekUuid(input.id) : null;
    const navn = tekstFelt(input?.navn, G.pakkeNavn, KODE_FEJL.ugyldigt_navn)!;
    const beskrivelse = tekstFelt(input.beskrivelse, G.pakkeBeskrivelse, KODE_FEJL.ugyldig_beskrivelse, false);
    const pris = input.maanedspris;
    if (pris !== null && (!Number.isInteger(pris) || pris < 0 || pris > G.pakkePrisMaks)) kodeFejl("ugyldig_pris");
    const ubegraenset = input.auktionerPrMaaned === null;
    const antal = input.auktionerPrMaaned ?? input.auktionerPrUge ?? null;
    if (!ubegraenset && (antal === null || !Number.isInteger(antal) || antal < 1 || antal > G.auktionerPrMaanedMaks)) {
      kodeFejl("ugyldigt_antal");
    }
    const fremh = input.fremhaevningerPrMaaned ?? null;
    if (fremh !== null && (!Number.isInteger(fremh) || fremh < 0 || fremh > 1000)) kodeFejl("ugyldige_fremhaevninger");
    const statistik = input.statistik ?? null;
    if (statistik !== null && !["ingen", "statistik", "fuld"].includes(statistik)) kodeFejl("ugyldig_statistik");
    const sortering = Number.isInteger(input.sortering) ? input.sortering! : 0;
    const rabatPct = input.ugensButikRabatProcent ?? null;
    const rabatAntal = input.ugensButikRabatAntal ?? null;
    if (
      (rabatPct === null) !== (rabatAntal === null) ||
      (rabatPct !== null && (!Number.isInteger(rabatPct) || rabatPct < 0 || rabatPct > 90)) ||
      (rabatAntal !== null && (!Number.isInteger(rabatAntal) || rabatAntal < 0 || rabatAntal > 52))
    ) {
      kodeFejl("ugyldig_rabat");
    }

    // Den gamle pris: ændres den, laves en ny pris i Stripe (priser kan ikke
    // ændres i Stripe). Eksisterende abonnementer beholder den gamle pris,
    // til firmaet skifter pakke.
    let gammelPris: number | null = null;
    if (id) {
      const { data: gammel } = await admin.from("erhverv_pakker").select("maanedspris").eq("id", id).maybeSingle();
      const v = (gammel as { maanedspris: number | string | null } | null)?.maanedspris;
      gammelPris = v == null ? null : Number(v);
    }

    const { data, error } = await admin.rpc("erhverv_pakke_gem", {
      p_staff: userId,
      p_id: id,
      p_navn: navn,
      p_beskrivelse: beskrivelse,
      p_maanedspris: pris,
      p_auktioner_pr_maaned: ubegraenset ? null : antal,
      p_ubegraenset: ubegraenset,
      p_fremhaevninger_pr_maaned: fremh,
      p_statistik: statistik,
      p_fast_kontaktperson: typeof input.fastKontaktperson === "boolean" ? input.fastKontaktperson : null,
      p_aktiv: input.aktiv !== false,
      p_sortering: sortering,
      p_ugens_butik_rabat_procent: rabatPct,
      p_ugens_butik_rabat_antal: rabatAntal,
    });
    if (error) throw new Error(error.message);
    const svar = data as { kode?: string; id?: string } | null;
    if (svar?.kode !== "ok" || !svar.id) kodeFejl(svar?.kode);
    revalidatePath("/admin/erhverv");

    let besked: string | undefined;
    if (pris !== null && pris > 0 && pris !== gammelPris && stripeTilgaengelig()) {
      try {
        await sikrPris(svar.id);
        const { count } = await admin
          .from("firmaer")
          .select("id", { count: "exact", head: true })
          .eq("pakke_id", svar.id)
          .not("stripe_subscription_id", "is", null)
          .neq("abonnement_status", "opsagt");
        besked = id ? AB.prisNyStripe(count ?? 0) : undefined;
      } catch (err) {
        await logDriftFejl({ kilde: "action", hvor: "gemErhvervPakke/sikrPris", fejl: err, brugerId: userId });
        besked = AB.prisStripeFejl;
      }
    }
    return { ok: true as const, id: svar.id, besked };
  });
}

// --- CVR-opslag ---------------------------------------------------------------------

// Udfylder firmanavn/adresse ud fra CVR (cvrapi.dk). Fejler opslaget, taster
// staff selv oplysningerne.
export async function slaaCvrOp(cvrInput: string) {
  return koer("slaaCvrOp", async () => {
    const { userId } = await assertErhverv();
    if (!renCvr(cvrInput)) throw new BrugerFejl(KODE_FEJL.ugyldigt_cvr);
    if (!(await indenForGraense("cvr_opslag_staff", userId))) throw new BrugerFejl(FOR_MANGE_FORSOEG);
    const svar: CvrOpslag = await slaaCvrOpOffentligt(cvrInput);
    if (!svar.ok) {
      const tekst =
        svar.grund === "ikke_fundet"
          ? "CVR-nummeret blev ikke fundet. Tjek nummeret, eller udfyld oplysningerne selv."
          : svar.grund === "ugyldigt_cvr"
            ? KODE_FEJL.ugyldigt_cvr
            : "CVR-opslaget virker ikke lige nu. Udfyld oplysningerne selv.";
      return { ok: false as const, fejl: tekst };
    }
    return { ok: true as const, firma: svar };
  });
}

// Serverens tjek ved oprettelse af en firmakonto (UI'et viser det samme, men
// kan omgås). Afviser, når cvrapi.dk med sikkerhed svarer, at CVR'et ikke
// findes (NOT_FOUND/404) eller er ophørt (slutdato). Er opslaget nede eller
// svarer med en fejl ("utilgaengelig"), tillades oprettelsen, og det logges -
// en midlertidig fejl hos CVR-registret må ikke spærre for nye firmaer.
async function kraevAktivtCvr(cvr: string, staffId: string): Promise<void> {
  const vurdering = cvrTilOprettelse(await slaaCvrOpOffentligt(cvr));
  if (vurdering === "ok") return;
  if (vurdering === "ikke_aktivt") kodeFejl("cvr_ikke_aktivt");
  if (vurdering === "ugyldigt_cvr") kodeFejl("ugyldigt_cvr");
  if (vurdering === "ikke_fundet") kodeFejl("cvr_ikke_fundet");
  console.warn(`opretFirmakonto: CVR-opslag utilgængeligt for ${cvr} - oprettelsen tillades uden tjek.`);
  await logDriftFejl({
    kilde: "action",
    hvor: "opretFirmakonto.cvr_opslag",
    fejl: `CVR-registret (cvrapi.dk) svarede ikke ved oprettelse af en firmakonto med CVR ${cvr}. Kontoen blev oprettet uden tjek af, om CVR'et er aktivt - kontrollér det på datacvr.virk.dk.`,
    brugerId: staffId,
  });
}

// --- Firmaer ---------------------------------------------------------------------

export type FirmaAdmin = {
  id: string;
  bruger_id: string;
  firmanavn: string;
  cvr: string;
  adresse: string;
  postnummer: string;
  bynavn: string;
  telefon: string;
  kontakt_email: string;
  kontaktperson: string;
  henvendelse_id: string | null;
  pakke_id: string;
  abonnement_status: AbonnementStatus;
  abonnement_start: string;
  naeste_pakke_id: string | null;
  naeste_pakke_fra: string | null;
  betalt_til: string | null;
  betaling_mislykket_kl: string | null;
  pauset_aarsag: "betaling" | "bidhamr" | null;
  opsagt_kl: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_abonnement_status: string | null;
  opsiges_fra: string | null;
  periode_slut: string | null;
  oprettet_kl: string;
  login_email: string;
  har_logget_ind: boolean;
  pakke: ErhvervPakke | null;
  naeste_pakke: ErhvervPakke | null;
  afventende_opgradering: (ErhvervPakke & { skift_id: string }) | null;
  aktive_auktioner: number;
  oprettet_af_navn: string | null;
  // 20261102010000 (erhverv_firma_abonnement_json): gratis periode,
  // introrabat, særpris, kort, månedskvote og fremhævninger.
  proeve_maaneder: number;
  proeve_slut: string | null;
  saerpris_aftale: string | null;
} & FirmaAbonnement;

export async function hentFirmaer() {
  return koer("hentFirmaer", async () => {
    const { admin, userId } = await assertErhverv();
    const { data, error } = await admin.rpc("erhverv_firmaer_liste", { p_staff: userId });
    if (error) throw new Error(error.message);
    return { ok: true as const, firmaer: (data ?? []) as FirmaAdmin[] };
  });
}

type FirmaFelter = {
  firmanavn: string;
  cvr: string;
  adresse: string;
  postnummer: string;
  by: string;
  telefon: string;
  kontaktEmail: string;
  kontaktperson: string;
};

function tjekFirmaFelter(input: Partial<FirmaFelter>): FirmaFelter {
  const cvr = renCvr(input.cvr);
  if (!cvr) throw new BrugerFejl(KODE_FEJL.ugyldigt_cvr);
  const postnummer = (input.postnummer ?? "").trim();
  if (!POSTNUMMER.test(postnummer)) throw new BrugerFejl("Postnummeret skal have 4 cifre.");
  const telefon = renTelefon(input.telefon);
  if (!telefon) throw new BrugerFejl("Skriv et gyldigt telefonnummer.");
  const kontaktEmail = (input.kontaktEmail ?? "").trim().toLowerCase();
  if (!EMAIL.test(kontaktEmail) || kontaktEmail.length > G.email) {
    throw new BrugerFejl("Skriv en gyldig kontakt-e-mail.");
  }
  return {
    firmanavn: tekstFelt(input.firmanavn, G.firmanavn, "Skriv firmaets navn.")!,
    cvr,
    adresse: tekstFelt(input.adresse, G.adresse, "Skriv firmaets adresse.")!,
    postnummer,
    by: tekstFelt(input.by, G.by, "Skriv byen.")!,
    telefon,
    kontaktEmail,
    kontaktperson: tekstFelt(input.kontaktperson, G.kontaktperson, "Skriv kontaktpersonens navn.")!,
  };
}

// Engangslink i velkomstmailen. /auth/callback indløser det IKKE ved
// visning (mail-scannere åbner links), men sender til mellemsiden /bekraeft;
// først knappen dér logger firmaet ind og sender det til "Vælg adgangskode".
// ?velkommen=1 får /reset-password til at vise "Vælg din adgangskode" i
// stedet for "Ny adgangskode".
function velkomstLink(hashedToken: string, type: "invite" | "recovery") {
  const p = new URLSearchParams({ token_hash: hashedToken, type, next: "/reset-password?velkommen=1" });
  return sideUrl(`/auth/callback?${p.toString()}`);
}

// Linket i velkomstmailen: BidHamrs egen billet, der gælder i 24 timer og
// laver et frisk Supabase-link, hver gang den åbnes (src/lib/erhverv/
// velkomstBillet.ts, /auth/velkomst). Kan billetten ikke laves (migrationen
// 20261102040000 er ikke kørt, eller databasen fejler), bruges Supabase-linket
// direkte som før - det gælder kun 1 time (projektets "Email OTP
// expiration"), og mailen siger det.
async function velkomstMailLink(
  admin: Awaited<ReturnType<typeof assertErhverv>>["admin"],
  brugerId: string,
  staffId: string,
  supabaseLink: () => Promise<string>,
): Promise<{ url: string; timer: number }> {
  try {
    const url = await udstedVelkomstBillet(admin, brugerId, staffId);
    if (url) return { url, timer: VELKOMST_TIMER };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "erhverv/velkomstbillet", fejl: err, brugerId: staffId });
  }
  return { url: await supabaseLink(), timer: 1 };
}

// Sletter den tomme auth-bruger, som generateLink lige har oprettet, når
// erhverv_firma_opret fejler. Først fjerner databasen public.users-rækken
// (kun hvis kontoen er helt ny og tom - ellers 'ikke_tom'), derefter slettes
// auth-brugeren via admin API. Returnerer true, hvis begge dele lykkedes.
async function rydTomKonto(
  admin: Awaited<ReturnType<typeof assertErhverv>>["admin"],
  staffId: string,
  brugerId: string,
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("erhverv_tom_konto_ryd", { p_staff: staffId, p_bruger: brugerId });
    const kode = (data as { kode?: string } | null)?.kode;
    if (error || (kode !== "ok" && kode !== "findes_ikke")) {
      console.error("erhverv_tom_konto_ryd:", error?.message ?? kode);
      return false;
    }
    const { error: sletFejl } = await admin.auth.admin.deleteUser(brugerId);
    if (sletFejl && sletFejl.status !== 404) {
      console.error("deleteUser:", sletFejl.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("rydTomKonto:", err);
    return false;
  }
}

// Tidligere firmakonto med samme CVR, der har haft et abonnement
// (erhverv_cvr_tidligere, 20261102020000).
export type CvrTidligereFirma = {
  firmanavn: string;
  abonnement_status: string;
  abonnement_start: string | null;
  opsagt_kl: string | null;
  havde_gratis_periode: boolean;
  betalte_regninger: number;
};

// Svar, når CVR'et har haft et abonnement før, og staff ikke har bekræftet:
// intet er oprettet. Formularen viser listen og "Opret alligevel".
export type CvrTidligereSvar = { cvrTidligere: true; firmaer: CvrTidligereFirma[] };

function tidligereListe(v: unknown): CvrTidligereFirma[] {
  if (!Array.isArray(v)) return [];
  return v.map((f: Record<string, unknown>) => ({
    firmanavn: String(f.firmanavn ?? ""),
    abonnement_status: String(f.abonnement_status ?? ""),
    abonnement_start: typeof f.abonnement_start === "string" ? f.abonnement_start : null,
    opsagt_kl: typeof f.opsagt_kl === "string" ? f.opsagt_kl : null,
    havde_gratis_periode: f.havde_gratis_periode === true,
    betalte_regninger: Number(f.betalte_regninger ?? 0) || 0,
  }));
}

export async function opretFirmakonto(
  input: FirmaFelter & {
    loginEmail: string;
    pakkeId: string;
    henvendelseId?: string | null;
    // Introrabat efter den gratis måned (fx INTRO_STANDARD: 50 % i 6 måneder).
    // Begge eller ingen. 1 måned gratis får alle nye firmaer automatisk.
    introProcent?: number | null;
    introMaaneder?: number | null;
    // Staff har set advarslen om, at CVR'et har haft et abonnement før, og
    // trykket "Opret alligevel".
    cvrBekraeftet?: boolean;
  },
) {
  return koer("opretFirmakonto", async () => {
    const { admin, userId } = await assertErhverv();
    if (!(await indenForGraense("erhverv_opret_staff", userId))) throw new BrugerFejl(FOR_MANGE_FORSOEG);

    const felter = tjekFirmaFelter(input ?? {});
    const loginEmail = (input.loginEmail ?? "").trim().toLowerCase();
    if (!EMAIL.test(loginEmail) || loginEmail.length > G.email) {
      throw new BrugerFejl("Skriv en gyldig e-mail til firmakontoen.");
    }
    const pakkeId = tjekUuid(input.pakkeId, KODE_FEJL.ugyldig_pakke);
    const henvendelseId = input.henvendelseId ? tjekUuid(input.henvendelseId) : null;
    const introProcent = input.introProcent ?? null;
    const introMaaneder = input.introMaaneder ?? null;
    if (
      (introProcent === null) !== (introMaaneder === null) ||
      (introProcent !== null && (!Number.isInteger(introProcent) || introProcent < 1 || introProcent > 100)) ||
      (introMaaneder !== null && (!Number.isInteger(introMaaneder) || introMaaneder < 1 || introMaaneder > 24))
    ) {
      kodeFejl("ugyldig_rabat_intro");
    }

    // CVR-registret (samme opslag som knappen "Slå CVR op"): kun et aktivt
    // dansk CVR kan få en firmakonto. Afvises kun, når opslaget med sikkerhed
    // siger, at CVR'et ikke findes eller er ophørt.
    await kraevAktivtCvr(felter.cvr, userId);

    // Forhåndstjek FØR auth-brugeren oprettes (en auth-bruger kan ikke
    // slettes igen, når users-rækken findes - handelsdata/arkiv). Databasen
    // tjekker det hele igen i erhverv_firma_opret.
    const [eksisterende, cvrAktiv, pakke, brugtHenv] = await Promise.all([
      admin.from("users").select("id").eq("email", loginEmail).limit(1),
      admin.from("firmaer").select("id").eq("cvr", felter.cvr).neq("abonnement_status", "opsagt").limit(1),
      admin.from("erhverv_pakker").select("id").eq("id", pakkeId).is("arkiveret_kl", null).maybeSingle(),
      henvendelseId
        ? admin.from("firmaer").select("id").eq("henvendelse_id", henvendelseId).limit(1)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const r of [eksisterende, cvrAktiv, pakke, brugtHenv]) if (r.error) throw new Error(r.error.message);
    if ((eksisterende.data ?? []).length > 0) kodeFejl("ikke_ny_konto");
    if ((cvrAktiv.data ?? []).length > 0) kodeFejl("cvr_findes");
    if (!pakke.data) kodeFejl("ugyldig_pakke");
    if ((brugtHenv.data ?? []).length > 0) kodeFejl("henvendelse_brugt");

    // Har CVR'et haft et abonnement før (fx opsagt efter en gratis periode)?
    // Så skal staff bekræfte, før noget oprettes - også før auth-brugeren.
    // PGRST202: migrationen 20261102020000 er ikke kørt - så intet tjek, og
    // erhverv_firma_opret kaldes som før (uden p_cvr_bekraeftet).
    const cvrBekraeftet = input.cvrBekraeftet === true;
    const { data: tidl, error: tidlFejl } = await admin.rpc("erhverv_cvr_tidligere", {
      p_staff: userId,
      p_cvr: felter.cvr,
    });
    const medCvrTjek = tidlFejl?.code !== "PGRST202";
    if (tidlFejl && medCvrTjek) throw new Error(`erhverv_cvr_tidligere: ${tidlFejl.message}`);
    if (medCvrTjek) {
      const t = tidl as { kode?: string; tidligere?: boolean; firmaer?: unknown } | null;
      if (!t || t.kode !== "ok") kodeFejl(t?.kode);
      if (t.tidligere && !cvrBekraeftet) {
        return { cvrTidligere: true as const, firmaer: tidligereListe(t.firmaer) };
      }
    }

    // Databasen afviser enhver ny konto uden en billet fra serveren, bundet
    // til netop dette kald med et engangs-nonce (handle_new_user,
    // 20261018010000_signup_billet_altid.sql). Billetten lader netop denne
    // e-mail oprette én konto inden for 10 minutter - kun med nonce'et, som
    // sendes med i generateLink (metadata bh_billet) og fjernes bagefter.
    const nb = nyBillet();
    let { data: billet, error: billetFejl } = await admin.rpc("konto_oprettelse_tillad", {
      p_staff: userId,
      p_email: loginEmail,
      p_hash: nb.hash,
    });
    // PGRST202: migrationen 20261018010000 er ikke kørt endnu - så bruges den
    // gamle billet uden nonce (20261017010000). Findes den heller ikke, er der
    // intet værn, og kontoen kan oprettes som før.
    let medNonce = true;
    if (billetFejl?.code === "PGRST202") {
      medNonce = false;
      ({ data: billet, error: billetFejl } = await admin.rpc("konto_oprettelse_tillad", {
        p_staff: userId,
        p_email: loginEmail,
      }));
    }
    const uden = billetFejl?.code === "PGRST202";
    if (!uden && (billetFejl || (billet as { kode?: string } | null)?.kode !== "ok")) {
      throw new Error(`konto_oprettelse_tillad: ${billetFejl?.message ?? (billet as { kode?: string } | null)?.kode ?? "intet svar"}`);
    }

    // Ny auth-bruger + engangslink. generateLink sender ingen mail.
    const { data: link, error: linkFejl } = await admin.auth.admin.generateLink({
      type: "invite",
      email: loginEmail,
      options: { data: { navn: felter.firmanavn, ...(medNonce ? { bh_billet: nb.nonce } : {}) } },
    });
    if (linkFejl || !link?.user || !link.properties?.hashed_token) {
      // Ingen konto blev oprettet: fjern billetten igen, så den ikke ligger
      // og venter i de resterende minutter.
      if (medNonce) {
        await fjernBillet(nb.hash);
      } else {
        const { error: sletFejl } = await admin.from("konto_oprettelse_billetter").delete().eq("email", loginEmail);
        if (sletFejl && sletFejl.code !== "42P01" && sletFejl.code !== "PGRST205") {
          console.error("opretFirmakonto: billet ikke slettet:", sletFejl.message);
        }
      }
      if (linkFejl?.code === "email_exists" || linkFejl?.status === 422) kodeFejl("ikke_ny_konto");
      throw new Error(`generateLink: ${linkFejl?.code ?? ""} ${linkFejl?.message ?? "intet svar"}`);
    }
    if (medNonce) await fjernBilletFraMetadata(link.user.id);

    const { data, error } = await admin.rpc("erhverv_firma_opret", {
      p_staff: userId,
      p_bruger: link.user.id,
      p_firmanavn: felter.firmanavn,
      p_cvr: felter.cvr,
      p_adresse: felter.adresse,
      p_postnummer: felter.postnummer,
      p_by: felter.by,
      p_telefon: felter.telefon,
      p_kontakt_email: felter.kontaktEmail,
      p_kontaktperson: felter.kontaktperson,
      p_pakke: pakkeId,
      p_henvendelse: henvendelseId,
      p_intro_procent: introProcent,
      p_intro_maaneder: introMaaneder,
      ...(medCvrTjek ? { p_cvr_bekraeftet: cvrBekraeftet } : {}),
    });
    const svar = data as { kode?: string; firma_id?: string; firmaer?: unknown } | null;
    if (error || svar?.kode !== "ok" || !svar.firma_id) {
      // Auth-brugeren findes nu som en tom (privat) konto uden firma. Den
      // slettes igen automatisk (ingen handelsdata) - databasen tjekker, at
      // den er under 5 minutter gammel, aldrig har logget ind og ingen
      // aktivitet har (erhverv_tom_konto_ryd).
      const ryddet = await rydTomKonto(admin, userId, link.user.id);
      await logDriftFejl({
        kilde: "action",
        hvor: "opretFirmakonto",
        fejl: `Firmakonto ikke oprettet efter generateLink (bruger ${link.user.id}): ${error?.message ?? svar?.kode ?? "ukendt"}. Tom konto ${ryddet ? "slettet igen" : "IKKE slettet - ryd op manuelt"}.`,
        brugerId: userId,
      });
      // CVR'et har fået et abonnement siden forhåndstjekket: vis advarslen
      // (den tomme konto er ryddet væk). Kunne den ikke ryddes, falder vi
      // igennem til fejlen med besked om den tomme konto.
      if (svar?.kode === "cvr_tidligere_abonnement" && ryddet) {
        return { cvrTidligere: true as const, firmaer: tidligereListe(svar.firmaer) };
      }
      if (svar?.kode === "cvr_tidligere_abonnement") svar.kode = "cvr_tidligere";
      if (svar?.kode === "ugyldig_rabat") svar.kode = "ugyldig_rabat_intro";
      if (svar?.kode && KODE_FEJL[svar.kode]) {
        throw new BrugerFejl(
          ryddet
            ? KODE_FEJL[svar.kode]
            : `${KODE_FEJL[svar.kode]} Bemærk: der er oprettet en tom konto på ${loginEmail} - kontakt en udvikler, før du prøver igen med samme e-mail.`,
        );
      }
      throw new Error(error?.message ?? `erhverv_firma_opret: ${svar?.kode ?? "intet svar"}`);
    }

    // Stripe-kunden laves nu; abonnementet (1 måned gratis + evt.
    // introrabat) starter, når firmaet trykker "Betal for din pakke".
    const betaling = await startAbonnement(svar.firma_id);

    const hashedToken = link.properties.hashed_token;
    const velkomst = await velkomstMailLink(admin, link.user.id, userId, async () => velkomstLink(hashedToken, "invite"));
    const mail = firmaVelkomstMail({
      firmanavn: felter.firmanavn,
      email: loginEmail,
      linkUrl: velkomst.url,
      linkTimer: velkomst.timer,
    });
    const sendt = await sendHandelMailDetaljer(loginEmail, mail);
    if (!sendt.ok) {
      await logDriftFejl({ kilde: "action", hvor: "opretFirmakonto.velkomstmail", fejl: sendt.fejl, brugerId: userId });
    }

    revalidatePath("/admin/erhverv");
    return {
      ok: true as const,
      firmaId: svar.firma_id,
      mailSendt: sendt.ok,
      betaling: betaling.status,
      besked: sendt.ok
        ? `Firmakontoen er oprettet, og velkomstmailen er sendt til ${loginEmail}.`
        : "Firmakontoen er oprettet, men velkomstmailen kunne ikke sendes. Brug \"Send velkomstmail igen\".",
    };
  });
}

// Nyt engangslink til et firma, der endnu ikke har logget ind.
export async function gensendFirmaVelkomst(firmaId: string) {
  return koer("gensendFirmaVelkomst", async () => {
    const { admin, userId } = await assertErhverv();
    const id = tjekUuid(firmaId);
    const { data: firma, error } = await admin
      .from("firmaer")
      .select("id, bruger_id, firmanavn, users!firmaer_bruger_id_fkey(email)")
      .eq("id", id)
      .maybeSingle<{ id: string; bruger_id: string; firmanavn: string; users: { email: string } | null }>();
    if (error) throw new Error(error.message);
    if (!firma?.users?.email) kodeFejl("ikke_fundet");

    const { data: auth, error: authFejl } = await admin.auth.admin.getUserById(firma.bruger_id);
    if (authFejl) throw new Error(authFejl.message);
    if (auth.user?.last_sign_in_at) {
      throw new BrugerFejl("Firmaet har allerede logget ind. Glemt adgangskode? Brug \"Glemt adgangskode\" på login-siden.");
    }
    if (!(await indenForGraense("erhverv_velkomst_firma", firma.id))) throw new BrugerFejl(FOR_MANGE_FORSOEG);

    const email = firma.users.email;
    // Ny billet (24 timer) - den gamle annulleres. Er migrationen
    // 20261102040000 ikke kørt, sendes et Supabase-link (1 time) som før.
    const velkomst = await velkomstMailLink(admin, firma.bruger_id, userId, async () => {
      const { data: link, error: linkFejl } = await admin.auth.admin.generateLink({ type: "recovery", email });
      if (linkFejl || !link?.properties?.hashed_token) {
        throw new Error(`generateLink recovery: ${linkFejl?.code ?? ""} ${linkFejl?.message ?? ""}`);
      }
      return velkomstLink(link.properties.hashed_token, "recovery");
    });
    const sendt = await sendHandelMailDetaljer(
      email,
      firmaVelkomstMail({
        firmanavn: firma.firmanavn,
        email,
        linkUrl: velkomst.url,
        linkTimer: velkomst.timer,
        gensendt: true,
      }),
    );
    if (!sendt.ok) throw new BrugerFejl("Mailen kunne ikke sendes. Prøv igen om lidt.");

    const { error: logFejl } = await admin.from("moderation_log").insert({
      medarbejder_id: userId,
      handling: "firma_velkomst_gensendt",
      maal_type: "firma",
      maal_id: firma.id,
      bruger_id: firma.bruger_id,
      aarsag: firma.firmanavn,
    });
    if (logFejl) console.error("Kunne ikke logge firma_velkomst_gensendt:", logFejl.message);
    return { ok: true as const };
  });
}

// Staff ændrer et firma. Udeladte felter er uændrede. pakkeId skifter pakken
// MED DET SAMME (chef eller sælger, fx efter en aftale med firmaet). Har firmaet et
// abonnement i Stripe, ændres det FØRST (skiftPrisAdmin: ventende
// opgraderinger annulleres, en planlagt nedgradering frigives, og prisen
// skifter med proration 'none' - dvs. fra firmaets næste betaling; en evt.
// forskel i indeværende periode aftaler chefen med firmaet). Fejler Stripe,
// ændres databasen ikke; fejler databasen, sættes prisen i Stripe tilbage.
export async function opdaterFirma(input: {
  firmaId: string;
  pakkeId?: string | null;
  status?: AbonnementStatus | null;
  felter?: Partial<FirmaFelter> | null;
  note?: string | null;
}) {
  return koer("opdaterFirma", async () => {
    const { admin, userId } = await assertErhverv();
    const firmaId = tjekUuid(input?.firmaId);
    const pakkeId = input.pakkeId ? tjekUuid(input.pakkeId, KODE_FEJL.ugyldig_pakke) : null;
    if (input.status != null && !erAbonnementStatus(input.status)) throw new BrugerFejl("Ugyldig status.");
    const f = input.felter ? tjekFirmaFelter(input.felter) : null;
    // Chef og sælger må ændre alle felter, pakke og status (Filip, 10. okt.
    // 2026). Databasen tjekker igen (erhverv_firma_opdater, 20261016040000).
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) : null;

    // "Opsagt" må ikke sættes her, mens firmaet har et abonnement i Stripe -
    // så ville Stripe blive ved med at trække betalingen. Brug "Opsig
    // abonnement" (opsigFirmaAbonnement).
    if (input.status === "opsagt") {
      const { data: fr } = await admin
        .from("firmaer")
        .select("stripe_subscription_id, stripe_abonnement_status")
        .eq("id", firmaId)
        .maybeSingle();
      const r = fr as { stripe_subscription_id: string | null; stripe_abonnement_status: string | null } | null;
      if (r?.stripe_subscription_id && r.stripe_abonnement_status !== "canceled") throw new BrugerFejl(AB.brugOpsigKnap);
    }

    // Pakkeskift: Stripe først (se ovenfor).
    let stripePris: AdminPrisSvar | null = null;
    if (pakkeId) {
      const { data: fp, error: fpFejl } = await admin.from("firmaer").select("pakke_id").eq("id", firmaId).maybeSingle();
      if (fpFejl) throw new Error(fpFejl.message);
      const nuvaerende = (fp as { pakke_id: string } | null)?.pakke_id ?? null;
      if (nuvaerende && nuvaerende !== pakkeId) {
        try {
          stripePris = await skiftPrisAdmin(firmaId, pakkeId);
        } catch (err) {
          if (err instanceof PakkeskiftIGang) throw new BrugerFejl(err.message);
          await logDriftFejl({ kilde: "action", hvor: "adminErhverv.opdaterFirma/stripe", fejl: err, brugerId: userId });
          throw new BrugerFejl(AB.pakkeStripeFejl);
        }
      }
    }

    // Pakkeskift-låsen (taget af skiftPrisAdmin) frigives, når databasen er
    // opdateret - eller prisen er sat tilbage.
    const laas = stripePris?.status === "ok" ? stripePris.laas : null;
    try {
      const { data, error } = await admin.rpc("erhverv_firma_opdater", {
        p_staff: userId,
        p_firma: firmaId,
        p_pakke: pakkeId,
        p_status: input.status ?? null,
        p_firmanavn: f?.firmanavn ?? null,
        p_cvr: f?.cvr ?? null,
        p_adresse: f?.adresse ?? null,
        p_postnummer: f?.postnummer ?? null,
        p_by: f?.by ?? null,
        p_telefon: f?.telefon ?? null,
        p_kontakt_email: f?.kontaktEmail ?? null,
        p_kontaktperson: f?.kontaktperson ?? null,
        p_note: note || null,
      });
      const kode = (data as { kode?: string } | null)?.kode;
      if (error || kode !== "ok") {
        if (stripePris?.status === "ok") await saetAdminPrisTilbage(stripePris);
        if (error) throw new Error(error.message);
        kodeFejl(kode);
      }
    } finally {
      if (laas) await frigivPakkeskiftLaas(firmaId, laas);
    }
    revalidatePath("/admin/erhverv");
    return { ok: true as const, besked: stripePris?.status === "ok" ? AB.pakkeSkiftetStripe : undefined };
  });
}

// --- Opsigelse (chef og sælger) -------------------------------------------------

// Opsiger firmaets abonnement: i Stripe stopper det ved slutningen af den
// betalte periode (cancel_at_period_end, ingen refusion), og webhooken
// customer.subscription.deleted sætter firmaet til 'opsagt'. Har firmaet
// intet abonnement i Stripe, opsiges det med det samme i databasen.
// (Lukkes kontoen permanent, opsiges abonnementet med det samme automatisk -
// opsigVedLukning i src/lib/erhverv/betaling.ts.)
export async function opsigFirmaAbonnement(firmaId: string) {
  return koer("opsigFirmaAbonnement", async () => {
    const { admin, userId } = await assertErhverv();
    const id = tjekUuid(firmaId);
    const svar = await opsigAbonnement(id);
    if (svar.status === "i_gang") throw new BrugerFejl(svar.fejl);
    if (svar.status === "fejl") throw new Error(svar.fejl);
    if (svar.status === "ingen_stripe") {
      const { data, error } = await admin.rpc("erhverv_firma_opdater", {
        p_staff: userId,
        p_firma: id,
        p_status: "opsagt",
        p_note: "Opsagt (intet abonnement i Stripe)",
      });
      if (error) throw new Error(error.message);
      const kode = (data as { kode?: string } | null)?.kode;
      if (kode !== "ok") kodeFejl(kode);
      revalidatePath("/admin/erhverv");
      return { ok: true as const, besked: AB.opsagtStraks };
    }
    const fra = new Date(svar.fra).toLocaleDateString("da-DK", {
      timeZone: "Europe/Copenhagen",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    await logFirmaHaendelse(admin, userId, id, `Abonnement opsagt i Stripe - stopper ${fra}`);
    revalidatePath("/admin/erhverv");
    return { ok: true as const, besked: AB.opsagt(fra) };
  });
}

export async function fortrydFirmaOpsigelse(firmaId: string) {
  return koer("fortrydFirmaOpsigelse", async () => {
    const { admin, userId } = await assertErhverv();
    const id = tjekUuid(firmaId);
    const svar = await fortrydOpsigelse(id);
    if (svar.status === "fejl") throw new Error(svar.fejl);
    await logFirmaHaendelse(admin, userId, id, "Opsigelse af abonnement fortrudt");
    revalidatePath("/admin/erhverv");
    return { ok: true as const, besked: AB.fortrudt };
  });
}

async function logFirmaHaendelse(
  admin: Awaited<ReturnType<typeof assertErhverv>>["admin"],
  staffId: string,
  firmaId: string,
  tekst: string,
) {
  const { data: f } = await admin.from("firmaer").select("bruger_id, firmanavn, cvr").eq("id", firmaId).maybeSingle();
  const r = f as { bruger_id: string; firmanavn: string; cvr: string } | null;
  const { error } = await admin.from("moderation_log").insert({
    medarbejder_id: staffId,
    handling: "firma_opdateret",
    maal_type: "firma",
    maal_id: firmaId,
    bruger_id: r?.bruger_id ?? null,
    aarsag: `${tekst}; ${r?.firmanavn ?? ""} (CVR ${r?.cvr ?? "-"})`.slice(0, 1000),
  });
  if (error) await logDriftFejl({ kilde: "action", hvor: "logFirmaHaendelse", fejl: error, brugerId: staffId });
}
