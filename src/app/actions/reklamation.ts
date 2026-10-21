"use server";

// Sælgeren registrerer selv sin reklamation hos fragtfirmaet (migration
// 20261029010000): anmeldt (+ sagsnummer), godkendt (+ beløb - udbetales
// direkte af fragtfirmaet), afvist (+ evt. grund) eller "Jeg ønsker ikke at
// reklamere". Én action pr. knap. Databasen afgør adgangen ud fra
// brugerens session (auth.uid() = sælgeren) og håndhæver statusskiftene.
// Appen kalder de samme RPC'er direkte (mit_fragt_reklamation_*).
// Fejl RETURNERES som { fejl }.
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { sagSti } from "@/lib/sager";
import { kroner, kronerTilOere } from "@/lib/reklamation/typer";

export type MinReklamationSvar = { ok: true; uaendret?: boolean } | { fejl: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = "Noget gik galt. Prøv igen om lidt.";

const KODE: Record<string, string> = {
  ingen_adgang: "Log ind, og prøv igen.",
  ikke_fundet: "Reklamationen findes ikke.",
  forkert_status: "Reklamationen er allerede afsluttet. Genindlæs siden.",
  for_lang_tekst: "Teksten er for lang.",
};

async function koer(navn: string, rpc: string, args: Record<string, unknown>, tradeId?: string): Promise<MinReklamationSvar> {
  try {
    const supabase = await createClient();
    const { data: bruger } = await supabase.auth.getUser();
    if (!bruger.user) return { fejl: KODE.ingen_adgang };
    const { data, error } = await supabase.rpc(rpc, args);
    if (error) {
      console.error(`Reklamation (sælger): ${navn} fejlede:`, error.message);
      return { fejl: GENERISK };
    }
    const svar = (data ?? {}) as Record<string, unknown>;
    if (svar.kode !== "ok") {
      if (svar.kode === "ugyldigt_beloeb" && typeof svar.maks_oere === "number") {
        return { fejl: `Beløbet kan højst være ${kroner(svar.maks_oere)}.` };
      }
      return { fejl: KODE[String(svar.kode ?? "")] ?? GENERISK };
    }
    if (tradeId && UUID.test(tradeId)) revalidatePath(sagSti(tradeId));
    return svar.uaendret === true ? { ok: true, uaendret: true } : { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    console.error(`Reklamation (sælger): ${navn} kastede:`, err);
    return { fejl: GENERISK };
  }
}

export async function reklamationAnmeldt(reklamationId: string, sagsnummer?: string, tradeId?: string) {
  if (!UUID.test(reklamationId)) return { fejl: KODE.ikke_fundet };
  return koer("anmeldt", "mit_fragt_reklamation_anmeldt", {
    p_reklamation: reklamationId,
    p_sagsnummer: typeof sagsnummer === "string" ? sagsnummer : null,
  }, tradeId);
}

// beloebKr: dansk format, fx "1.250,00".
export async function reklamationGodkendt(reklamationId: string, beloebKr: string, tradeId?: string) {
  if (!UUID.test(reklamationId)) return { fejl: KODE.ikke_fundet };
  const oere = kronerTilOere(String(beloebKr ?? ""));
  if (oere === null) return { fejl: "Skriv beløbet i kroner, fx 1.250,00." };
  return koer("godkendt", "mit_fragt_reklamation_godkendt", { p_reklamation: reklamationId, p_beloeb_oere: oere }, tradeId);
}

export async function reklamationAfvist(reklamationId: string, grund?: string, tradeId?: string) {
  if (!UUID.test(reklamationId)) return { fejl: KODE.ikke_fundet };
  return koer("afvist", "mit_fragt_reklamation_afvist", {
    p_reklamation: reklamationId,
    p_grund: typeof grund === "string" ? grund : null,
  }, tradeId);
}

export async function reklamationFravaelg(reklamationId: string, tradeId?: string) {
  if (!UUID.test(reklamationId)) return { fejl: KODE.ikke_fundet };
  return koer("fravaelg", "mit_fragt_reklamation_fravaelg", { p_reklamation: reklamationId }, tradeId);
}
