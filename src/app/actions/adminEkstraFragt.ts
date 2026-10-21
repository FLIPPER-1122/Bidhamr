"use server";

// Staff: ekstra fragt ved for lille pakkestørrelse (migration
// 20261029020000_ekstra_fragt.sql). Én action pr. knap:
//   1. forberedEkstraFragtUpload({ tradeId, filtype })   -> signeret upload-URL
//      (browseren uploader fragtfirmaets faktura direkte til den private bucket)
//   2. opretEkstraFragt({ forsendelseId, sti, ... })      -> regningen oprettes
//   frafaldEkstraFragt(id, grund)                         -> frafald (grund vises for sælgeren)
//   afgoerEkstraFragtIndsigelse(id, udfald, begrundelse)  -> frafald/fasthold
//   genaabnEkstraFragt(id, begrundelse)                   -> genåbn efter tabt bankindsigelse
//   afslutEkstraFragtBankindsigelse(id, begrundelse)      -> afslut tabt bankindsigelse uden genåbning
//   gemEkstraFragtNote(id, note)                          -> intern note
//   hentEkstraFragtDokumentationStaff(id)                 -> signeret link (10 min)
//
// Adgang: assertRole("medarbejder") (rolle + to-trins-login på admin-hosten),
// og databasen tjekker igen med BRUGERENS session: auth.uid() + er_staff()
// (rolle OG aal2) + inhabilitet. Derfor kaldes RPC'erne med createClient() -
// ikke service-role. Alt logges i moderation_log (maal_type 'handel').
// Ingen af dem flytter penge: en ekstraregning betales kun, når sælgeren
// selv trykker Betal.
// Fejl RETURNERES som { fejl } (Next skjuler kastede fejl i produktion).
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { assertRole } from "@/lib/adminAuth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { sagSti } from "@/lib/sager";
import { annullerKasseretPi, EKSTRA_FRAGT_BUCKET, signeretDokumentationsLink } from "@/lib/betaling/ekstraFragt";
import { notificerEkstraFragt } from "@/lib/ekstraFragt/notifikationer";
import { EKSTRA_FRAGT_STAFF_FEJL, erMaaltStoerrelse, kgTilGram, kronerTilOere } from "@/lib/ekstraFragt/tekster";

export type EkstraFragtStaffSvar = { ok: true; id?: string; uaendret?: boolean } | { fejl: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const INGEN_ADGANG = "Du har ikke adgang til at gøre dette.";
const MIGRATION = "Ekstra fragt kræver migrationen 20261029020000_ekstra_fragt.sql.";
const MAKS_BYTES = 10 * 1024 * 1024;

// Tilladte filtyper -> endelse og magiske bytes (tjekkes på den uploadede fil).
const FILTYPER: Record<string, { endelse: string; tjek: (b: Uint8Array) => boolean }> = {
  "application/pdf": { endelse: "pdf", tjek: (b) => b.length > 4 && String.fromCharCode(b[0], b[1], b[2], b[3]) === "%PDF" },
  "image/jpeg": { endelse: "jpg", tjek: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": {
    endelse: "png",
    tjek: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  "image/webp": {
    endelse: "webp",
    tjek: (b) => b.length > 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" && String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP",
  },
  "image/heic": { endelse: "heic", tjek: (b) => b.length > 12 && String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp" },
  "image/heif": { endelse: "heic", tjek: (b) => b.length > 12 && String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp" },
};

function erUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

function tekst(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function fejlTekst(kode: string): string {
  return EKSTRA_FRAGT_STAFF_FEJL[kode] ?? GENERISK;
}

function afvisning(err: unknown): EkstraFragtStaffSvar | null {
  if (err instanceof Error && ["Ingen adgang", "Ikke logget ind", "Kræver to-trins-login"].includes(err.message)) {
    return { fejl: INGEN_ADGANG };
  }
  return null;
}

function revalider(tradeId?: string | null) {
  revalidatePath("/admin/handler");
  revalidatePath("/admin/fragt");
  if (tradeId && UUID.test(tradeId)) revalidatePath(sagSti(tradeId));
}

// --- 1. Upload af dokumentationen --------------------------------------------

export type EkstraFragtUpload =
  | { ok: true; sti: string; token: string; signedUrl: string }
  | { fejl: string };

// Giver en signeret upload-URL (2 timer) til fragtfirmaets faktura for
// handlen. Browseren uploader direkte (supabase.storage.from(bucket)
// .uploadToSignedUrl(sti, token, fil)) - så filen ikke går gennem en server
// action (1 MB-grænse). Bucket'en tillader kun PDF/billeder op til 10 MB.
export async function forberedEkstraFragtUpload(input: { tradeId: string; filtype: string }): Promise<EkstraFragtUpload> {
  try {
    const adgang = await assertRole("medarbejder");
    if (!erUuid(input?.tradeId)) return { fejl: "Handlen findes ikke." };
    const type = FILTYPER[String(input.filtype ?? "").toLowerCase()];
    if (!type) return { fejl: "Upload fragtfirmaets faktura som PDF eller billede (JPG, PNG, WEBP, HEIC)." };
    const sti = `${input.tradeId.toLowerCase()}/${randomUUID()}.${type.endelse}`;
    const { data, error } = await adgang.admin.storage.from(EKSTRA_FRAGT_BUCKET).createSignedUploadUrl(sti);
    if (error || !data) throw new Error(`createSignedUploadUrl: ${error?.message ?? "intet svar"}`);
    return { ok: true, sti: data.path, token: data.token, signedUrl: data.signedUrl };
  } catch (err) {
    unstable_rethrow(err);
    const a = afvisning(err);
    if (a && "fejl" in a) return a;
    console.error("Ekstra fragt: forbered upload fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "admin/ekstra-fragt", hvor: "Ekstra fragt: forbered upload", fejl: err });
    return { fejl: GENERISK };
  }
}

// Stien fra forberedEkstraFragtUpload: <handels-id>/<uuid>.<endelse>.
const DOKUMENTATION_STI =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp|heic)$/;

// Tjekker den uploadede fil (sti, størrelse og magiske bytes). Er den
// ugyldig, slettes den - men KUN hvis stien er en gyldig upload-sti under
// forsendelsens egen handel (<trade_id>/), og ingen regning bruger filen
// (staff kan ikke slette andres dokumentation ved at angive dens sti).
async function tjekFil(
  admin: ReturnType<typeof createAdminClient>,
  sti: string,
  type: string,
  tradeId: string,
): Promise<string | null> {
  const t = FILTYPER[type];
  if (!DOKUMENTATION_STI.test(sti)) return "Filen er ikke uploadet. Upload fragtfirmaets faktura igen.";
  if (!erUuid(tradeId) || !sti.startsWith(`${tradeId.toLowerCase()}/`)) {
    return "Filen hører ikke til denne handel. Upload fragtfirmaets faktura igen.";
  }
  if (!t || !sti.endsWith(`.${t.endelse}`)) return "Filtypen passer ikke til filen.";
  const { data: brugt, error: brugtFejl } = await admin
    .from("ekstra_fragt_regninger")
    .select("id")
    .eq("dokumentation_sti", sti)
    .limit(1);
  if (brugtFejl) throw new Error(`ekstra_fragt_regninger (dokumentation): ${brugtFejl.message}`);
  if ((brugt ?? []).length > 0) return "Filen er allerede brugt til en regning. Upload fragtfirmaets faktura igen.";
  const { data, error } = await admin.storage.from(EKSTRA_FRAGT_BUCKET).download(sti);
  if (error || !data) return "Filen er ikke uploadet. Upload fragtfirmaets faktura igen.";
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAKS_BYTES || !t.tjek(bytes)) {
    await admin.storage.from(EKSTRA_FRAGT_BUCKET).remove([sti]).catch(() => {});
    return "Filen kunne ikke bruges. Upload fragtfirmaets faktura som PDF eller billede (højst 10 MB).";
  }
  return null;
}

// --- 2. Opret ----------------------------------------------------------------

export type OpretEkstraFragtInput = {
  forsendelseId: string;
  // Dansk format, fx "35,00" (forskellen inkl. moms, som fragtfirmaet har opkrævet).
  beloebKr: string;
  // Fragtfirmaets måling: mindst én af størrelse og vægt.
  maaltStoerrelse?: "lille" | "mellem" | "stor" | "over_stor" | null;
  maaltVaegtKg?: string | null; // fx "7,2"
  maaltMaal?: string | null; // fx "60 x 40 x 30 cm"
  fakturanummer: string;
  forklaring?: string | null; // vises for sælgeren
  // Fra forberedEkstraFragtUpload + upload.
  dokumentationSti: string;
  dokumentationType: string;
  dokumentationNavn?: string | null;
};

export async function opretEkstraFragt(input: OpretEkstraFragtInput): Promise<EkstraFragtStaffSvar> {
  try {
    const adgang = await assertRole("medarbejder");
    if (!erUuid(input?.forsendelseId)) return { fejl: fejlTekst("ikke_fundet") };
    const beloeb = kronerTilOere(String(input.beloebKr ?? ""));
    if (beloeb === null) return { fejl: "Skriv beløbet i kroner, fx 35,00." };
    if (input.maaltStoerrelse != null && !erMaaltStoerrelse(input.maaltStoerrelse)) return { fejl: fejlTekst("ugyldig_stoerrelse") };
    let gram: number | null = null;
    if (input.maaltVaegtKg != null && String(input.maaltVaegtKg).trim() !== "") {
      gram = kgTilGram(String(input.maaltVaegtKg));
      if (gram === null) return { fejl: "Skriv vægten i kg, fx 7,2." };
    }
    const sti = String(input.dokumentationSti ?? "");
    const type = String(input.dokumentationType ?? "").toLowerCase();
    // Forsendelsens handel: filen skal ligge under <trade_id>/ (før noget slettes).
    const { data: fs, error: fsFejl } = await adgang.admin
      .from("forsendelser")
      .select("trade_id")
      .eq("id", input.forsendelseId)
      .maybeSingle<{ trade_id: string | null }>();
    if (fsFejl) throw new Error(`forsendelser: ${fsFejl.message}`);
    if (!fs?.trade_id) return { fejl: fejlTekst("ikke_fundet") };
    const filFejl = await tjekFil(adgang.admin, sti, type, fs.trade_id);
    if (filFejl) return { fejl: filFejl };

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("ekstra_fragt_opret", {
      p_forsendelse: input.forsendelseId,
      p_beloeb_oere: beloeb,
      p_maalt_stoerrelse: input.maaltStoerrelse ?? null,
      p_maalt_vaegt_gram: gram,
      p_maalt_maal: tekst(input.maaltMaal),
      p_fakturanummer: tekst(input.fakturanummer) ?? "",
      p_forklaring: tekst(input.forklaring),
      p_dokumentation_sti: sti,
      p_dokumentation_type: type,
      p_dokumentation_navn: tekst(input.dokumentationNavn),
    });
    if (error) {
      if (["PGRST202", "42883"].includes(error.code ?? "")) return { fejl: MIGRATION };
      throw new Error(error.message);
    }
    const svar = (data ?? {}) as { kode?: string; id?: string; trade_id?: string };
    if (svar.kode !== "ok" || !svar.id) return { fejl: fejlTekst(String(svar.kode ?? "")) };
    after(() => notificerEkstraFragt());
    revalider(svar.trade_id);
    return { ok: true, id: svar.id };
  } catch (err) {
    unstable_rethrow(err);
    const a = afvisning(err);
    if (a) return a;
    console.error("Ekstra fragt: opret fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "admin/ekstra-fragt", hvor: "Ekstra fragt: opret", fejl: err });
    return { fejl: GENERISK };
  }
}

// --- Frafald, afgør indsigelse, note ------------------------------------------

async function koer(navn: string, rpc: string, args: Record<string, unknown>): Promise<EkstraFragtStaffSvar> {
  try {
    await assertRole("medarbejder");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(rpc, args);
    if (error) {
      if (["PGRST202", "42883"].includes(error.code ?? "")) return { fejl: MIGRATION };
      throw new Error(error.message);
    }
    const svar = (data ?? {}) as { kode?: string; annuller_pi?: string | null; trade_id?: string; uaendret?: boolean };
    if (svar.kode !== "ok") return { fejl: fejlTekst(String(svar.kode ?? "")) };
    // En åben PaymentIntent er kasseret: annullér den hos Stripe (cron'en
    // prøver igen, hvis det fejler). Beskeden til sælgeren sendes med det samme.
    const id = String(args.p_id ?? "");
    if (svar.annuller_pi) {
      const pi = svar.annuller_pi;
      after(() => annullerKasseretPi(id, pi));
    }
    after(() => notificerEkstraFragt());
    revalider(svar.trade_id);
    return svar.uaendret === true ? { ok: true, uaendret: true } : { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    const a = afvisning(err);
    if (a) return a;
    console.error(`Ekstra fragt: ${navn} fejlede:`, err);
    await logDriftFejl({ kilde: "action", sti: "admin/ekstra-fragt", hvor: `Ekstra fragt: ${navn}`, fejl: err });
    return { fejl: GENERISK };
  }
}

// Frafald regningen (uden indsigelse eller under en). grund vises for sælgeren.
export async function frafaldEkstraFragt(regningId: string, grund: string): Promise<EkstraFragtStaffSvar> {
  if (!erUuid(regningId)) return { fejl: fejlTekst("ikke_fundet") };
  return koer("frafald", "ekstra_fragt_frafald", { p_id: regningId, p_grund: tekst(grund) ?? "" });
}

// Afgør sælgerens indsigelse. udfald 'frafald' | 'fasthold'; begrundelsen
// vises for sælgeren. Fastholdt: sælgeren har mindst 7 dage til at betale.
export async function afgoerEkstraFragtIndsigelse(
  regningId: string,
  udfald: "frafald" | "fasthold",
  begrundelse: string,
): Promise<EkstraFragtStaffSvar> {
  if (!erUuid(regningId)) return { fejl: fejlTekst("ikke_fundet") };
  if (udfald !== "frafald" && udfald !== "fasthold") return { fejl: fejlTekst("ugyldigt_udfald") };
  return koer("afgør indsigelse", "ekstra_fragt_afgoer_indsigelse", {
    p_id: regningId,
    p_udfald: udfald,
    p_begrundelse: tekst(begrundelse) ?? "",
  });
}

// Genåbn en BETALT regning, hvis betaling er tilbageført efter en TABT
// bankindsigelse (chargeback). Sker aldrig automatisk (Filip, 21. okt. 2026).
// Kreditnotaen for den tilbageførte betaling er lavet automatisk ved tabet.
// Databasen (ekstra_fragt_genaabn - staff med aal2, ikke inhabil, logget)
// giver i én transaktion en ny frist (14 dage) og en ny betalingsrunde
// (sælgeren får en ny PaymentIntent med ny idempotency key, når han trykker
// Betal; ny faktura, når han har betalt). Kan også bruges efter "Afslut uden
// genåbning". begrundelse vises for sælgeren, som får besked. Flytter ingen penge.
export async function genaabnEkstraFragt(regningId: string, begrundelse: string): Promise<EkstraFragtStaffSvar> {
  if (!erUuid(regningId)) return { fejl: fejlTekst("ikke_fundet") };
  return koer("genåbn", "ekstra_fragt_genaabn", { p_regning: regningId, p_begrundelse: tekst(begrundelse) ?? "" });
}

// Afslut en TABT bankindsigelse UDEN genåbning: regningen forbliver lukket,
// sælgeren opkræves ikke igen, og admin-lampen slukkes. Databasen
// (ekstra_fragt_bankindsigelse_afslut - staff med aal2, ikke inhabil,
// logget). begrundelse er intern (vises ikke for sælgeren). Flytter ingen penge.
export async function afslutEkstraFragtBankindsigelse(regningId: string, begrundelse: string): Promise<EkstraFragtStaffSvar> {
  if (!erUuid(regningId)) return { fejl: fejlTekst("ikke_fundet") };
  return koer("afslut bankindsigelse", "ekstra_fragt_bankindsigelse_afslut", {
    p_regning: regningId,
    p_begrundelse: tekst(begrundelse) ?? "",
  });
}

export async function gemEkstraFragtNote(regningId: string, note: string): Promise<EkstraFragtStaffSvar> {
  if (!erUuid(regningId)) return { fejl: fejlTekst("ikke_fundet") };
  return koer("note", "ekstra_fragt_gem_note", { p_id: regningId, p_note: tekst(note) ?? "" });
}

// Signeret link (10 min) til dokumentationen.
export async function hentEkstraFragtDokumentationStaff(regningId: string): Promise<{ ok: true; url: string } | { fejl: string }> {
  try {
    await assertRole("medarbejder");
    if (!erUuid(regningId)) return { fejl: fejlTekst("ikke_fundet") };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("ekstra_fragt_dokumentation_staff", { p_id: regningId });
    if (error) {
      if (["PGRST202", "42883"].includes(error.code ?? "")) return { fejl: MIGRATION };
      throw new Error(error.message);
    }
    const svar = (data ?? {}) as { kode?: string; sti?: string; navn?: string | null };
    if (svar.kode !== "ok" || !svar.sti) return { fejl: fejlTekst(String(svar.kode ?? "")) };
    const url = await signeretDokumentationsLink(svar.sti, svar.navn);
    if (!url) return { fejl: "Filen kunne ikke findes. Kontakt en udvikler." };
    return { ok: true, url };
  } catch (err) {
    unstable_rethrow(err);
    const a = afvisning(err);
    if (a && "fejl" in a) return a;
    console.error("Ekstra fragt: dokumentation (staff) fejlede:", err);
    return { fejl: GENERISK };
  }
}
