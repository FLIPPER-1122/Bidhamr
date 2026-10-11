"use server";

// Admin -> Beta-fejl: skift status og gem staff-noten. Kun admin og chef
// (assertRole). Tabellen beta_fejl kan kun røres med service_role
// (20261018020000_beta_fejl.sql). Fejl RETURNERES som { fejl }.

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { BETA_FEJL_MAKS_NOTE, erBetaFejlStatus } from "@/lib/betaFejl";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

export async function opdaterBetaFejl(input: {
  id: string;
  status: string;
  staffNote: string | null;
}): Promise<{ ok: true } | { fejl: string }> {
  try {
    const { admin, userId } = await assertRole("admin");
    if (typeof input?.id !== "string" || !UUID.test(input.id)) return { fejl: "Ugyldigt id." };
    if (!erBetaFejlStatus(input.status)) return { fejl: "Vælg en gyldig status." };
    const note =
      typeof input.staffNote === "string"
        ? input.staffNote.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim()
        : "";
    if (note.length > BETA_FEJL_MAKS_NOTE) return { fejl: `Noten må højst være ${BETA_FEJL_MAKS_NOTE} tegn.` };

    const { data, error } = await admin
      .from("beta_fejl")
      .update({
        status: input.status,
        staff_note: note || null,
        opdateret_af: userId,
        opdateret_kl: new Date().toISOString(),
      })
      .eq("id", input.id)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`beta_fejl update: ${error.message}`);
    if (!data) return { fejl: "Fejlen findes ikke." };
    revalidatePath("/admin/beta-fejl");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Du har ikke adgang til at gøre det." };
    }
    console.error("opdaterBetaFejl fejlede:", err);
    await logDriftFejl({ kilde: "action", hvor: "adminBetaFejl.opdater", fejl: err });
    return { fejl: GENERISK };
  }
}
