"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";

// Admin -> Fakturaer (kun chef): "Prøv igen" og "Markér som håndteret i
// Dinero" for fakturaer, der er opgivet eller stoppet. Rollen tjekkes her OG
// i databasen (faktura_proev_igen / faktura_haandteret_manuelt kræver chef).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

const KODER: Record<string, string> = {
  ingen_adgang: "Kun chefen kan gøre det.",
  ikke_fundet: "Fakturaen findes ikke.",
  manuel: "Denne faktura skal laves manuelt i Dinero og derefter markeres som håndteret.",
  faerdig: "Fakturaen er allerede færdig.",
  koerer: "Fakturaen behandles stadig automatisk - vent lidt.",
  note_mangler: "Skriv kort, hvad du har gjort i Dinero.",
};

export async function proevFakturaIgen(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const { userId, admin } = await assertRole("chef");
    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) return { fejl: KODER.ikke_fundet };
    const { data, error } = await admin.rpc("faktura_proev_igen", { p_medarbejder: userId, p_id: id });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode ?? "fejl";
    if (kode !== "ok") return { fejl: KODER[kode] ?? GENERISK };
    revalidatePath("/admin/fakturaer");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    console.error("proevFakturaIgen fejlede:", err);
    return { fejl: GENERISK };
  }
}

export async function fakturaHaandteretManuelt(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const { userId, admin } = await assertRole("chef");
    const id = String(formData.get("id") ?? "");
    const note = String(formData.get("note") ?? "").slice(0, 1000);
    if (!UUID.test(id)) return { fejl: KODER.ikke_fundet };
    const { data, error } = await admin.rpc("faktura_haandteret_manuelt", {
      p_medarbejder: userId,
      p_id: id,
      p_note: note,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode ?? "fejl";
    if (kode !== "ok") return { fejl: KODER[kode] ?? GENERISK };
    revalidatePath("/admin/fakturaer");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    console.error("fakturaHaandteretManuelt fejlede:", err);
    return { fejl: GENERISK };
  }
}
