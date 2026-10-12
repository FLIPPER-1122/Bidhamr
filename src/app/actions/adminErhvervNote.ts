"use server";

// "Notér" på en erhvervshenvendelse: sender KUN den nye note. Databasen
// (erhverv_henvendelse_tilfoej_note, 20261020010000_admin_hurtig.sql) lægger
// den til de gamle med dato og navn og sætter en ny henvendelse til 'i gang'.
// Så overskriver to samtidige noter ikke hinanden. Chef og sælger
// (assertErhverv + erhverv_har_adgang i databasen). Fejl RETURNERES.

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertErhverv } from "@/lib/adminAuth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KODE: Record<string, string> = {
  ikke_fundet: "Henvendelsen findes ikke længere. Opdater siden.",
  tom_note: "Skriv en note.",
  for_lang_note: "Noten er for lang. Ret de gamle noter på henvendelsen.",
};

export async function tilfoejErhvervNote(input: { id: string; note: string }): Promise<{ ok: true; status: string } | { fejl: string }> {
  try {
    const { admin, userId } = await assertErhverv();
    if (!UUID.test(input?.id ?? "")) return { fejl: KODE.ikke_fundet };
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!note) return { fejl: KODE.tom_note };
    if (note.length > 1000) return { fejl: "Noten må højst være 1000 tegn." };
    const { data, error } = await admin.rpc("erhverv_henvendelse_tilfoej_note", { p_staff: userId, p_id: input.id, p_note: note });
    if (error && ["PGRST202", "42883"].includes(error.code ?? "")) {
      return { fejl: "Noter kræver migrationen 20261020010000_admin_hurtig.sql." };
    }
    if (error) throw new Error(error.message);
    const svar = (data ?? {}) as { kode?: string; status?: string };
    if (svar.kode !== "ok") return { fejl: KODE[svar.kode ?? ""] ?? "Noget gik galt. Prøv igen." };
    revalidatePath("/admin/erhverv", "layout");
    return { ok: true, status: svar.status ?? "" };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Du har ikke adgang til Erhverv." };
    }
    console.error("tilfoejErhvervNote fejlede:", err);
    return { fejl: "Noget gik galt. Prøv igen, eller kontakt en udvikler." };
  }
}
