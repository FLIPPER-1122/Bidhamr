"use server";

// Admin → Erhverv (kun chef og sælger; pakker og priser kun chef).
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
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { firmaVelkomstMail } from "@/lib/mails/erhverv";
import { sideUrl } from "@/lib/mails/layout";
import { slaaCvrOpOffentligt, type CvrOpslag } from "@/lib/erhverv/cvr";
import { startAbonnement } from "@/lib/erhverv/betaling";
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
  ugyldigt_antal: `Antal auktioner pr. uge skal være mellem 1 og ${G.auktionerPrUgeMaks}.`,
  navn_findes: "Der findes allerede en pakke med det navn.",
  bruger_findes_ikke: "Kontoen kunne ikke oprettes. Prøv igen.",
  ikke_ny_konto: "E-mailen har allerede en konto hos BidHamr. Brug en anden e-mail til firmakontoen.",
  ugyldigt_cvr: "CVR-nummeret skal have 8 cifre.",
  cvr_findes: "Der findes allerede en aktiv firmakonto med det CVR-nummer.",
  ugyldig_pakke: "Vælg en pakke.",
  henvendelse_findes_ikke: "Henvendelsen findes ikke længere.",
  henvendelse_brugt: "Der er allerede oprettet en firmakonto ud fra denne henvendelse.",
  ugyldige_felter: "Tjek felterne og prøv igen.",
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

export type ErhvervPakkeAdmin = ErhvervPakke & { sortering: number; antal_firmaer: number };

export async function hentErhvervPakker() {
  return koer("hentErhvervPakker", async () => {
    const { admin, userId } = await assertErhverv();
    const { data, error } = await admin.rpc("erhverv_pakker_liste", { p_staff: userId });
    if (error) throw new Error(error.message);
    return { ok: true as const, pakker: (data ?? []) as ErhvervPakkeAdmin[] };
  });
}

// Kun chef. id udeladt = ny pakke. maanedspris null = ikke sat endnu.
export async function gemErhvervPakke(input: {
  id?: string | null;
  navn: string;
  beskrivelse?: string | null;
  maanedspris: number | null;
  auktionerPrUge: number;
  aktiv?: boolean;
  sortering?: number;
}) {
  return koer("gemErhvervPakke", async () => {
    const { admin, userId } = await assertErhverv(true);
    const id = input?.id ? tjekUuid(input.id) : null;
    const navn = tekstFelt(input?.navn, G.pakkeNavn, KODE_FEJL.ugyldigt_navn)!;
    const beskrivelse = tekstFelt(input.beskrivelse, G.pakkeBeskrivelse, KODE_FEJL.ugyldig_beskrivelse, false);
    const pris = input.maanedspris;
    if (pris !== null && (!Number.isInteger(pris) || pris < 0 || pris > G.pakkePrisMaks)) kodeFejl("ugyldig_pris");
    const antal = input.auktionerPrUge;
    if (!Number.isInteger(antal) || antal < 1 || antal > G.auktionerPrUgeMaks) kodeFejl("ugyldigt_antal");
    const sortering = Number.isInteger(input.sortering) ? input.sortering! : 0;

    const { data, error } = await admin.rpc("erhverv_pakke_gem", {
      p_staff: userId,
      p_id: id,
      p_navn: navn,
      p_beskrivelse: beskrivelse,
      p_maanedspris: pris,
      p_auktioner_pr_uge: antal,
      p_aktiv: input.aktiv !== false,
      p_sortering: sortering,
    });
    if (error) throw new Error(error.message);
    const svar = data as { kode?: string; id?: string } | null;
    if (svar?.kode !== "ok" || !svar.id) kodeFejl(svar?.kode);
    revalidatePath("/admin/erhverv");
    return { ok: true as const, id: svar.id };
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
  oprettet_kl: string;
  login_email: string;
  har_logget_ind: boolean;
  pakke: ErhvervPakke | null;
  naeste_pakke: ErhvervPakke | null;
  afventende_opgradering: (ErhvervPakke & { skift_id: string }) | null;
  aktive_auktioner: number;
  oprettet_af_navn: string | null;
};

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

// Engangslink i velkomstmailen. Går via /auth/callback (verifyOtp på
// serveren), som logger firmaet ind og sender det til "Vælg adgangskode".
// ?velkommen=1 får /reset-password til at vise "Vælg din adgangskode" i
// stedet for "Ny adgangskode".
function velkomstLink(hashedToken: string, type: "invite" | "recovery") {
  const p = new URLSearchParams({ token_hash: hashedToken, type, next: "/reset-password?velkommen=1" });
  return sideUrl(`/auth/callback?${p.toString()}`);
}

export async function opretFirmakonto(
  input: FirmaFelter & { loginEmail: string; pakkeId: string; henvendelseId?: string | null },
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

    // Forhåndstjek FØR auth-brugeren oprettes (en auth-bruger kan ikke
    // slettes igen, når users-rækken findes - handelsdata/arkiv). Databasen
    // tjekker det hele igen i erhverv_firma_opret.
    const [eksisterende, cvrAktiv, pakke, brugtHenv] = await Promise.all([
      admin.from("users").select("id").eq("email", loginEmail).limit(1),
      admin.from("firmaer").select("id").eq("cvr", felter.cvr).neq("abonnement_status", "opsagt").limit(1),
      admin.from("erhverv_pakker").select("id").eq("id", pakkeId).maybeSingle(),
      henvendelseId
        ? admin.from("firmaer").select("id").eq("henvendelse_id", henvendelseId).limit(1)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const r of [eksisterende, cvrAktiv, pakke, brugtHenv]) if (r.error) throw new Error(r.error.message);
    if ((eksisterende.data ?? []).length > 0) kodeFejl("ikke_ny_konto");
    if ((cvrAktiv.data ?? []).length > 0) kodeFejl("cvr_findes");
    if (!pakke.data) kodeFejl("ugyldig_pakke");
    if ((brugtHenv.data ?? []).length > 0) kodeFejl("henvendelse_brugt");

    // Ny auth-bruger + engangslink. generateLink sender ingen mail.
    const { data: link, error: linkFejl } = await admin.auth.admin.generateLink({
      type: "invite",
      email: loginEmail,
      options: { data: { navn: felter.firmanavn } },
    });
    if (linkFejl || !link?.user || !link.properties?.hashed_token) {
      if (linkFejl?.code === "email_exists" || linkFejl?.status === 422) kodeFejl("ikke_ny_konto");
      throw new Error(`generateLink: ${linkFejl?.code ?? ""} ${linkFejl?.message ?? "intet svar"}`);
    }

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
    });
    const svar = data as { kode?: string; firma_id?: string } | null;
    if (error || svar?.kode !== "ok" || !svar.firma_id) {
      // Auth-brugeren findes nu som en almindelig (privat) konto uden firma.
      // Den kan ikke slettes automatisk - logges, så en udvikler kan rydde op.
      await logDriftFejl({
        kilde: "action",
        hvor: "opretFirmakonto",
        fejl: `Firmakonto ikke oprettet efter generateLink (bruger ${link.user.id}): ${error?.message ?? svar?.kode ?? "ukendt"}`,
        brugerId: userId,
      });
      if (svar?.kode && KODE_FEJL[svar.kode]) {
        throw new BrugerFejl(
          `${KODE_FEJL[svar.kode]} Bemærk: der er oprettet en tom konto på ${loginEmail} - kontakt en udvikler, før du prøver igen med samme e-mail.`,
        );
      }
      throw new Error(error?.message ?? `erhverv_firma_opret: ${svar?.kode ?? "intet svar"}`);
    }

    // Abonnementet (Stripe, på pause) - i dag 'afventer_betaling'.
    const betaling = await startAbonnement(svar.firma_id);

    const mail = firmaVelkomstMail({
      firmanavn: felter.firmanavn,
      email: loginEmail,
      linkUrl: velkomstLink(link.properties.hashed_token, "invite"),
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

    const { data: link, error: linkFejl } = await admin.auth.admin.generateLink({
      type: "recovery",
      email: firma.users.email,
    });
    if (linkFejl || !link?.properties?.hashed_token) {
      throw new Error(`generateLink recovery: ${linkFejl?.code ?? ""} ${linkFejl?.message ?? ""}`);
    }
    const sendt = await sendHandelMailDetaljer(
      firma.users.email,
      firmaVelkomstMail({
        firmanavn: firma.firmanavn,
        email: firma.users.email,
        linkUrl: velkomstLink(link.properties.hashed_token, "recovery"),
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
// MED DET SAMME (fx efter en aftale/betaling uden for Stripe).
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
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) : null;

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
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") kodeFejl(kode);
    revalidatePath("/admin/erhverv");
    return { ok: true as const };
  });
}
