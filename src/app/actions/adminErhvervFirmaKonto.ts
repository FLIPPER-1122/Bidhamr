"use server";

// Admin → Erhverv → Firmaer → [firma]: luk, suspendér, ophæv suspension og
// behandl forslag om lukning af en FIRMAKONTO (Filip, 10. okt. 2026: "Både
// chefen og rollen sælger skal kunne gøre alt ved firmaer").
//
// Adgang: assertErhverv (chef og sælger-rollen), og hver handling accepterer
// kun firmakonti (firmaer.bruger_id, users.konto_type = 'erhverv').
// Databasen afgør resten og logger i moderation_log:
//   - luk/suspendér: dsa_indgreb (samme DSA-begrundelse, mail og klageret
//     som DSA-flowet - via udfoerIndgreb)
//   - ophæv suspension: bruger_ophaev_suspension (permanent kun chef/sælger)
//   - forslag: dsa_konto_lukning_godkend (med DSA-begrundelse) og
//     konto_lukning_afvis
// Fejl RETURNERES som { fejl }.
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { assertErhverv } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { erRegel } from "@/lib/dsa/regler";
import { indgrebFejl, udfoerIndgreb } from "@/lib/dsa/server";
import { notificerAfgoerelse } from "@/lib/dsa/notifikationer";
import { FIRMA_KONTO_FEJL as FEJL } from "@/lib/tekster/erhvervKlager";

class BrugerFejl extends Error {}

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Svar = { ok: true } | { fejl: string };

async function koer(navn: string, fn: () => Promise<void>): Promise<Svar> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: FEJL.ingen_adgang };
    }
    console.error(`Firmakonto ${navn} fejlede:`, err);
    await logDriftFejl({ kilde: "action", hvor: `adminErhvervFirmaKonto.${navn}`, fejl: err });
    return { fejl: GENERISK };
  }
}

function felt(formData: FormData, navn: string): string {
  const v = formData.get(navn);
  return typeof v === "string" ? v.trim() : "";
}

function kodeTekst(kode: string | undefined): string {
  return (kode && (FEJL as Record<string, string>)[kode]) || indgrebFejl(kode ?? "");
}

type Adgang = Awaited<ReturnType<typeof assertErhverv>>;

// Firmaet og dets konto. Kaster BrugerFejl, hvis det ikke er en firmakonto.
async function hentFirmakonto(adgang: Adgang, firmaId: string) {
  if (!UUID.test(firmaId)) throw new BrugerFejl(FEJL.ikke_fundet);
  const { data: firma, error } = await adgang.admin
    .from("firmaer")
    .select("id, bruger_id")
    .eq("id", firmaId)
    .maybeSingle<{ id: string; bruger_id: string }>();
  if (error) throw new Error(error.message);
  if (!firma) throw new BrugerFejl(FEJL.ikke_fundet);
  const { data: bruger, error: bFejl } = await adgang.admin
    .from("users")
    .select("id, konto_type")
    .eq("id", firma.bruger_id)
    .maybeSingle<{ id: string; konto_type: string }>();
  if (bFejl) throw new Error(bFejl.message);
  if (bruger?.konto_type !== "erhverv") throw new BrugerFejl(FEJL.ikke_firma);
  return firma;
}

function revalider(firmaId: string, brugerId: string) {
  revalidatePath(`/admin/erhverv/firmaer/${firmaId}`);
  revalidatePath("/admin/erhverv/firmaer");
  revalidatePath("/admin/erhverv/klager", "layout");
  revalidatePath(`/admin/brugere/${brugerId}`);
  revalidatePath("/admin/kontolukninger");
  revalidatePath("/admin/dsa");
}

// DSA-felterne (regel, fakta til brugeren, intern note) - som DSA-flowet.
function indgrebFelter(formData: FormData) {
  const regel = felt(formData, "regel");
  const fakta = felt(formData, "fakta");
  const internNote = felt(formData, "aarsag");
  if (!erRegel(regel)) throw new BrugerFejl(FEJL.regel_mangler);
  if (!fakta) throw new BrugerFejl(FEJL.fakta_mangler);
  if (fakta.length > 2000 || internNote.length > 2000) throw new BrugerFejl(FEJL.for_lang_tekst);
  return { regel, fakta, internNote };
}

// formData: firmaId, regel, fakta, aarsag (intern).
export async function lukFirmakonto(formData: FormData): Promise<Svar> {
  return koer("lukFirmakonto", async () => {
    const adgang = await assertErhverv();
    const firma = await hentFirmakonto(adgang, felt(formData, "firmaId"));
    const f = indgrebFelter(formData);
    const r = await udfoerIndgreb(adgang.admin, {
      staffId: adgang.userId,
      type: "profil",
      id: firma.bruger_id,
      handling: "konto_lukket",
      regel: f.regel,
      fakta: f.fakta,
      internNote: f.internNote,
    });
    if (!r.ok) throw new BrugerFejl(kodeTekst(r.kode));
    revalider(firma.id, firma.bruger_id);
  });
}

// formData: firmaId, varighed (1 | 7 | permanent), regel, fakta, aarsag.
export async function suspenderFirmakonto(formData: FormData): Promise<Svar> {
  return koer("suspenderFirmakonto", async () => {
    const adgang = await assertErhverv();
    const firma = await hentFirmakonto(adgang, felt(formData, "firmaId"));
    const varighed = felt(formData, "varighed");
    if (varighed !== "1" && varighed !== "7" && varighed !== "permanent") {
      throw new BrugerFejl(FEJL.ugyldig_varighed);
    }
    const f = indgrebFelter(formData);
    const r = await udfoerIndgreb(adgang.admin, {
      staffId: adgang.userId,
      type: "profil",
      id: firma.bruger_id,
      handling: "konto_suspenderet",
      regel: f.regel,
      fakta: f.fakta,
      internNote: f.internNote,
      varighed,
    });
    if (!r.ok) throw new BrugerFejl(kodeTekst(r.kode));
    revalider(firma.id, firma.bruger_id);
  });
}

// formData: firmaId.
export async function ophaevFirmaSuspension(formData: FormData): Promise<Svar> {
  return koer("ophaevFirmaSuspension", async () => {
    const adgang = await assertErhverv();
    const firma = await hentFirmakonto(adgang, felt(formData, "firmaId"));
    const { data, error } = await adgang.admin.rpc("bruger_ophaev_suspension", {
      p_staff: adgang.userId,
      p_bruger: firma.bruger_id,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok" && kode !== "uaendret") throw new BrugerFejl(kodeTekst(kode));
    revalider(firma.id, firma.bruger_id);
  });
}

// Forslaget skal være om netop denne firmakonto.
async function hentForslag(adgang: Adgang, firmaId: string, forslagId: string) {
  const firma = await hentFirmakonto(adgang, firmaId);
  if (!UUID.test(forslagId)) throw new BrugerFejl(FEJL.ikke_fundet);
  const { data, error } = await adgang.admin
    .from("konto_lukning_forslag")
    .select("id, bruger_id")
    .eq("id", forslagId)
    .maybeSingle<{ id: string; bruger_id: string }>();
  if (error) throw new Error(error.message);
  if (!data || data.bruger_id !== firma.bruger_id) throw new BrugerFejl(FEJL.ikke_fundet);
  return firma;
}

// formData: firmaId, forslagId, note (intern, valgfri).
export async function godkendFirmaLukning(formData: FormData): Promise<Svar> {
  return koer("godkendFirmaLukning", async () => {
    const adgang = await assertErhverv();
    const forslagId = felt(formData, "forslagId");
    const firma = await hentForslag(adgang, felt(formData, "firmaId"), forslagId);
    const note = felt(formData, "note");
    if (note.length > 2000) throw new BrugerFejl(FEJL.for_lang_tekst);
    // Wrapper om konto_lukning_godkend, der også gemmer DSA-begrundelsen.
    const { data, error } = await adgang.admin.rpc("dsa_konto_lukning_godkend", {
      p_medarbejder: adgang.userId,
      p_forslag: forslagId,
      p_note: note || null,
    });
    if (error) throw new Error(error.message);
    const svar = (data ?? {}) as { kode?: string; afgoerelse_id?: string };
    if (svar.kode === "bortfaldet") {
      revalider(firma.id, firma.bruger_id);
      throw new BrugerFejl(FEJL.bortfaldet);
    }
    if (svar.kode !== "ok") throw new BrugerFejl(kodeTekst(svar.kode));
    const afgId = svar.afgoerelse_id;
    if (afgId) after(() => notificerAfgoerelse(afgId));
    revalider(firma.id, firma.bruger_id);
  });
}

// formData: firmaId, forslagId, begrundelse (intern, påkrævet).
export async function afvisFirmaLukning(formData: FormData): Promise<Svar> {
  return koer("afvisFirmaLukning", async () => {
    const adgang = await assertErhverv();
    const forslagId = felt(formData, "forslagId");
    const firma = await hentForslag(adgang, felt(formData, "firmaId"), forslagId);
    const begrundelse = felt(formData, "begrundelse");
    if (!begrundelse) throw new BrugerFejl(FEJL.begrundelse_mangler);
    if (begrundelse.length > 2000) throw new BrugerFejl(FEJL.for_lang_tekst);
    const { data, error } = await adgang.admin.rpc("konto_lukning_afvis", {
      p_medarbejder: adgang.userId,
      p_forslag: forslagId,
      p_begrundelse: begrundelse,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") throw new BrugerFejl(kodeTekst(kode));
    revalider(firma.id, firma.bruger_id);
  });
}
