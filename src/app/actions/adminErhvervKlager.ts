"use server";

// Admin → Erhverv → Klager (kun chef og saelger, som resten af Erhverv).
// Adgangen tjekkes her (assertErhverv) OG i databasen (erhverv_har_adgang i
// hver staff-RPC, som kun service_role kan kalde). Inhabilitet (staff har
// handlet med firmaet eller er køberen) tjekkes i databasen. Alle ændringer
// logges i moderation_log af databasen. Fejl RETURNERES som { fejl }.
//
// Købers e-mail i en klage vises for chef og saelger (Filip, 26. okt. 2026),
// men ikke ved inhabilitet. Hver visning logges af databasen
// (erhverv_klage_detalje, handling erhverv_klage_koeber_email_vist).
//
// Lukning af en firmakonto sker IKKE her: 3 advarsler giver et forslag under
// Kontolukninger, som kun chefen og sælger-rollen kan godkende
// (bruger_luk_konto_permanent svarer 'kun_erhverv' for firmakonti).
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { assertErhverv } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import {
  KLAGE_ADVARSEL_BEGRUNDELSE_MAKS,
  KLAGE_BEGRUNDELSE_MAKS,
  KLAGE_BUCKET,
  KLAGE_NOTE_MAKS,
  erKlageKanal,
  erKlageStatus,
  type KlageAfgoerelse,
  type KlageKanal,
  type KlageKategori,
  type KlageNoteType,
  type KlageStatus,
} from "@/lib/erhverv/klager";
import {
  KLAGE_ADMIN_FEJL,
  KLAGE_AFGOERELSE_NAVN,
  KLAGE_NOTIFIKATION as N,
} from "@/lib/tekster/erhvervKlager";

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
      return { fejl: KLAGE_ADMIN_FEJL.ingen_adgang };
    }
    console.error(`Erhverv-klager ${navn} fejlede:`, err);
    await logDriftFejl({ kilde: "action", hvor: `adminErhvervKlager.${navn}`, fejl: err });
    return { fejl: GENERISK };
  }
}

function tjekUuid(id: unknown): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new BrugerFejl(KLAGE_ADMIN_FEJL.ikke_fundet);
  return id;
}

function tekst(v: unknown, maks: number, mangler: string, paakraevet = true): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) {
    if (paakraevet) throw new BrugerFejl(mangler);
    return null;
  }
  if (s.length > maks) throw new BrugerFejl(KLAGE_ADMIN_FEJL.for_lang_tekst);
  return s;
}

function kodeFejl(kode: string | undefined): never {
  throw new BrugerFejl((kode && KLAGE_ADMIN_FEJL[kode]) || GENERISK);
}

function revalider(klageId?: string, tradeId?: string) {
  revalidatePath("/admin/erhverv/klager");
  if (klageId) revalidatePath(`/admin/erhverv/klager/${klageId}`);
  if (tradeId) revalidatePath(`/mine-handler/${tradeId}`);
  revalidatePath("/firma/klager");
}

// --- Liste ---------------------------------------------------------------------

export type AdminKlageRaekke = {
  id: string;
  nummer: number;
  trade_id: string;
  titel: string | null;
  firma_id: string;
  firmanavn: string;
  cvr: string;
  koeber_navn: string | null;
  kategori: KlageKategori;
  status: KlageStatus;
  afgoerelse: KlageAfgoerelse | null;
  oprettet_kl: string;
  afgjort_kl: string | null;
  behandles_af_navn: string | null;
  antal_noter: number;
};

export type AdminAdvarselForslag = {
  id: string;
  firma_id: string;
  firma_bruger_id: string;
  firmanavn: string;
  cvr: string;
  grundlag: "tre_klager" | "tidligere_advarsel";
  antal_klager: number;
  advarsler_antal: number;
  oprettet_kl: string;
};

export type AdminKlageListe = {
  antal: Record<KlageStatus, number>;
  klager: AdminKlageRaekke[];
  forslag: AdminAdvarselForslag[];
};

export async function hentErhvervKlager(filter: { status?: string | null; firma?: string | null }) {
  return koer("hentErhvervKlager", async () => {
    const { admin, userId } = await assertErhverv();
    const status = erKlageStatus(filter.status) ? filter.status : null;
    const firma = typeof filter.firma === "string" && UUID.test(filter.firma) ? filter.firma : null;
    const { data, error } = await admin.rpc("erhverv_klager_liste", {
      p_staff: userId,
      p_status: status,
      p_firma: firma,
    });
    if (error) throw new Error(error.message);
    const svar = data as ({ kode: string } & Partial<AdminKlageListe>) | null;
    if (svar?.kode !== "ok") kodeFejl(svar?.kode);
    return {
      ok: true as const,
      antal: svar.antal ?? { aaben: 0, under_behandling: 0, afsluttet: 0 },
      klager: svar.klager ?? [],
      forslag: svar.forslag ?? [],
    };
  });
}

// --- Én klage ------------------------------------------------------------------

export type AdminKlageDetalje = {
  er_chef: boolean;
  inhabil: boolean;
  klage: {
    id: string;
    nummer: number;
    trade_id: string;
    kategori: KlageKategori;
    // null, når staff er inhabil (databasen sender den ikke).
    beskrivelse: string | null;
    status: KlageStatus;
    afgoerelse: KlageAfgoerelse | null;
    begrundelse: string | null;
    oprettet_kl: string;
    afgjort_kl: string | null;
    afgjort_af_navn: string | null;
    behandles_af_navn: string | null;
    behandling_startet_kl: string | null;
    forslag_id: string | null;
  };
  billeder: { sti: string; url: string | null }[];
  noter: {
    id: string;
    type: KlageNoteType;
    kanal: KlageKanal | null;
    tekst: string;
    oprettet_kl: string;
    staff_navn: string | null;
  }[];
  handel: {
    id: string;
    titel: string | null;
    beloeb: number | string;
    status: string;
    oprettet_kl: string;
    afhentning: boolean;
    betalt_kl: string | null;
    refunderet_kl: string | null;
    sendt_kl: string | null;
    modtaget_kl: string | null;
  } | null;
  firma: {
    id: string;
    bruger_id: string;
    firmanavn: string;
    cvr: string;
    kontaktperson: string;
    telefon: string;
    kontakt_email: string;
    adresse: string;
    postnummer: string;
    bynavn: string;
    abonnement_status: string;
    konto_lukket: boolean;
  };
  koeber: { id: string; navn: string | null; email: string | null } | null;
  statistik: {
    klager_i_alt: number;
    berettigede_12_mdr: number;
    advarsler_antal: number;
    afventende_forslag: {
      id: string;
      grundlag: "tre_klager" | "tidligere_advarsel";
      antal_klager: number;
      oprettet_kl: string;
    } | null;
    lukning_foreslaaet: boolean;
  };
};

export async function hentErhvervKlage(id: string) {
  return koer("hentErhvervKlage", async () => {
    const klageId = tjekUuid(id);
    const { admin, userId } = await assertErhverv();
    const { data, error } = await admin.rpc("erhverv_klage_detalje", { p_staff: userId, p_klage: klageId });
    if (error) throw new Error(error.message);
    const svar = data as ({ kode: string; billeder?: string[] } & Omit<AdminKlageDetalje, "billeder">) | null;
    if (svar?.kode !== "ok") kodeFejl(svar?.kode);

    // Signerede links (1 time) til købers billeder - kun efter adgangstjekket.
    const stier = svar.billeder ?? [];
    let billeder: { sti: string; url: string | null }[] = stier.map((sti) => ({ sti, url: null }));
    if (stier.length > 0) {
      const { data: urls } = await admin.storage.from(KLAGE_BUCKET).createSignedUrls(stier, 3600);
      billeder = stier.map((sti) => ({ sti, url: urls?.find((u) => u.path === sti)?.signedUrl ?? null }));
    }
    const { kode: _kode, ...rest } = svar;
    void _kode;
    return { ok: true as const, detalje: { ...rest, billeder } as AdminKlageDetalje };
  });
}

// --- Handlinger ----------------------------------------------------------------

export async function tagErhvervKlage(id: string) {
  return koer("tagErhvervKlage", async () => {
    const klageId = tjekUuid(id);
    const { admin, userId } = await assertErhverv();
    const { data, error } = await admin.rpc("erhverv_klage_behandl", { p_staff: userId, p_klage: klageId });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok" && kode !== "uaendret") kodeFejl(kode);
    revalider(klageId);
    return { ok: true as const };
  });
}

export async function gemErhvervKlageNote(input: { id: string; type: string; kanal?: string | null; tekst: string }) {
  return koer("gemErhvervKlageNote", async () => {
    const klageId = tjekUuid(input.id);
    const type: KlageNoteType = input.type === "kontakt_firma" ? "kontakt_firma" : "note";
    let kanal: KlageKanal | null = null;
    if (type === "kontakt_firma") {
      if (!erKlageKanal(input.kanal)) throw new BrugerFejl(KLAGE_ADMIN_FEJL.ugyldig_kanal);
      kanal = input.kanal;
    }
    const t = tekst(input.tekst, KLAGE_NOTE_MAKS, KLAGE_ADMIN_FEJL.tekst_mangler)!;
    const { admin, userId } = await assertErhverv();
    const { data, error } = await admin.rpc("erhverv_klage_note", {
      p_staff: userId,
      p_klage: klageId,
      p_type: type,
      p_kanal: kanal,
      p_tekst: t,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok" && kode !== "uaendret") kodeFejl(kode);
    revalider(klageId);
    return { ok: true as const };
  });
}

export async function afgoerErhvervKlage(input: { id: string; afgoerelse: string; begrundelse: string }) {
  return koer("afgoerErhvervKlage", async () => {
    const klageId = tjekUuid(input.id);
    if (input.afgoerelse !== "berettiget" && input.afgoerelse !== "ikke_berettiget") {
      throw new BrugerFejl(KLAGE_ADMIN_FEJL.ugyldig_afgoerelse);
    }
    const afg = input.afgoerelse;
    const begrundelse = tekst(input.begrundelse, KLAGE_BEGRUNDELSE_MAKS, KLAGE_ADMIN_FEJL.begrundelse_mangler)!;
    const { admin, userId } = await assertErhverv();
    const { data, error } = await admin.rpc("erhverv_klage_afgoer", {
      p_staff: userId,
      p_klage: klageId,
      p_afgoerelse: afg,
      p_begrundelse: begrundelse,
    });
    if (error) throw new Error(error.message);
    const svar = data as {
      kode?: string;
      trade_id?: string;
      koeber_id?: string;
      firma_bruger_id?: string;
      nummer?: number;
      forslag_id?: string | null;
      forslag_ny?: boolean;
    } | null;
    if (svar?.kode !== "ok") kodeFejl(svar?.kode);

    // Besked til køber og firma (påkrævet type 'afgoerelse'). Kaster aldrig.
    const nr = Number(svar.nummer ?? 0);
    const afgTekst = KLAGE_AFGOERELSE_NAVN[afg];
    after(async () => {
      await send(svar.koeber_id, "afgoerelse", {
        titel: N.koeberTitel,
        tekst: N.koeberTekst(nr, afgTekst, begrundelse),
        link: svar.trade_id ? `/mine-handler/${svar.trade_id}#klage` : null,
        data: { erhverv_klage_id: klageId },
        noegle: `erhverv_klage_afgjort:${klageId}:koeber`,
      });
      await send(svar.firma_bruger_id, "afgoerelse", {
        titel: N.firmaTitel,
        tekst: N.firmaTekst(nr, afgTekst, begrundelse),
        link: "/firma/klager",
        data: { erhverv_klage_id: klageId },
        noegle: `erhverv_klage_afgjort:${klageId}:firma`,
      });
    });

    revalider(klageId, svar.trade_id);
    return { ok: true as const, forslagNy: svar.forslag_ny === true, forslagId: svar.forslag_id ?? null };
  });
}

export async function givFirmaAdvarselFraForslag(input: {
  forslagId: string;
  begrundelseBruger: string;
  internNote?: string | null;
}) {
  return koer("givFirmaAdvarselFraForslag", async () => {
    const forslagId = tjekUuid(input.forslagId);
    const begrundelse = tekst(
      input.begrundelseBruger,
      KLAGE_ADVARSEL_BEGRUNDELSE_MAKS,
      KLAGE_ADMIN_FEJL.begrundelse_bruger_mangler,
    )!;
    const note = tekst(input.internNote, 2000, "", false);
    const { admin, userId } = await assertErhverv();
    const { data, error } = await admin.rpc("erhverv_forslag_giv_advarsel", {
      p_staff: userId,
      p_forslag: forslagId,
      p_begrundelse_bruger: begrundelse,
      p_intern_note: note,
    });
    if (error) throw new Error(error.message);
    const svar = data as { kode?: string; firma_bruger_id?: string; lukning_foreslaaet?: boolean } | null;
    if (svar?.kode !== "ok") kodeFejl(svar?.kode);
    // Firmaet får besked om advarslen af notifikations-cron'en (som alle
    // andre advarsler, påkrævet type 'advarsel').
    revalider();
    revalidatePath("/admin", "layout");
    if (svar.firma_bruger_id) revalidatePath(`/admin/brugere/${svar.firma_bruger_id}`);
    return { ok: true as const, lukningForeslaaet: svar.lukning_foreslaaet === true };
  });
}

export async function afvisFirmaAdvarselForslag(input: { forslagId: string; begrundelse: string }) {
  return koer("afvisFirmaAdvarselForslag", async () => {
    const forslagId = tjekUuid(input.forslagId);
    const begrundelse = tekst(input.begrundelse, 2000, KLAGE_ADMIN_FEJL.begrundelse_mangler)!;
    const { admin, userId } = await assertErhverv();
    const { data, error } = await admin.rpc("erhverv_forslag_afvis", {
      p_staff: userId,
      p_forslag: forslagId,
      p_begrundelse: begrundelse,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") kodeFejl(kode);
    revalider();
    return { ok: true as const };
  });
}
