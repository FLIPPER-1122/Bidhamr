"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { BIDHAMR_SYSTEM_ID } from "@/lib/staffChat";

// Admin: MitID (20261013010000_mitid.sql). Reglerne ligger i databasen
// (mitid_nulstil: admin/chef, ikke sig selv, inhabilitet, ikke lukkede konti,
// staff-konti kun af chef, logges i moderation_log).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

const NULSTIL_FEJL: Record<string, string> = {
  ingen_adgang: "Kun admin og chef kan nulstille MitID.",
  aarsag_mangler: "Skriv en begrundelse (mindst 5 tegn).",
  aarsag_for_lang: "Begrundelsen må højst være 1000 tegn.",
  ugyldig_bruger: "Brugeren blev ikke fundet.",
  sig_selv: "Du kan ikke nulstille din egen MitID.",
  lukket: "En lukket konto kan ikke nulstilles – MitID'en skal blive ved kontoen.",
  staff: "Kun chefen kan nulstille MitID for en medarbejder.",
  inhabil: "Du kan ikke nulstille MitID for en bruger, du har handlet med.",
  ikke_verificeret: "Brugeren er ikke MitID-verificeret.",
};

export async function nulstilMitId(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const userId = String(formData.get("userId") ?? "").trim();
    const aarsag = String(formData.get("aarsag") ?? "").trim();
    if (!UUID.test(userId) || userId === BIDHAMR_SYSTEM_ID) return { fejl: NULSTIL_FEJL.ugyldig_bruger };
    const { admin, userId: staffId } = await assertRole("admin");
    const { data, error } = await admin.rpc("mitid_nulstil", {
      p_staff: staffId,
      p_bruger: userId,
      p_aarsag: aarsag,
    });
    if (error) throw error;
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") return { fejl: (kode && NULSTIL_FEJL[kode]) || GENERISK };
    revalidatePath(`/admin/brugere/${userId}`);
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    console.error("nulstilMitId fejlede:", err);
    return { fejl: GENERISK };
  }
}

export async function behandlMitIdForsoeg(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const forsoegId = String(formData.get("forsoegId") ?? "").trim();
    if (!UUID.test(forsoegId)) return { fejl: "Forsøget blev ikke fundet." };
    const { admin, userId: staffId } = await assertRole("medarbejder");
    const { data, error } = await admin.rpc("mitid_forsoeg_behandl", { p_staff: staffId, p_forsoeg: forsoegId });
    if (error) throw error;
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") return { fejl: kode === "ikke_fundet" ? "Forsøget er allerede gennemgået." : GENERISK };
    revalidatePath("/admin/brugere/mistaenkelig");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    console.error("behandlMitIdForsoeg fejlede:", err);
    return { fejl: GENERISK };
  }
}
