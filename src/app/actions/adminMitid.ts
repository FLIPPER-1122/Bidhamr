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

// Juridisk navn og fødselsdato fra MitID vises først i admin, når en
// medarbejder trykker "Vis" (sikkerhedsgennemgangen 10. okt. 2026). Staff kan
// ikke læse mitid_verificeringer direkte (RLS: kun brugeren selv); her læses
// via service role efter rolletjekket, og opslaget logges i moderation_log
// ('mitid_opslag'). Fail closed: kan opslaget ikke logges, returneres intet.
export type MitIdOplysninger = { juridiskNavn: string | null; foedselsdato: string | null };

export async function visMitIdOplysninger(
  brugerId: string,
): Promise<{ ok: true; data: MitIdOplysninger } | { fejl: string }> {
  try {
    const id = String(brugerId ?? "").trim();
    if (!UUID.test(id) || id === BIDHAMR_SYSTEM_ID) return { fejl: "Brugeren blev ikke fundet." };
    const { admin, userId: staffId } = await assertRole("medarbejder");
    const { data: v, error } = await admin
      .from("mitid_verificeringer")
      .select("juridisk_navn, foedselsdato")
      .eq("bruger_id", id)
      .eq("status", "aktiv")
      .maybeSingle<{ juridisk_navn: string | null; foedselsdato: string | null }>();
    if (error) throw error;
    if (!v) return { fejl: "Brugeren er ikke MitID-verificeret." };
    const { error: logFejl } = await admin.from("moderation_log").insert({
      medarbejder_id: staffId,
      handling: "mitid_opslag",
      maal_type: "bruger",
      maal_id: id,
      bruger_id: id,
      aarsag: "MitID-oplysninger (juridisk navn og fødselsdato) vist på brugersiden i admin",
    });
    if (logFejl) {
      console.error("visMitIdOplysninger: kunne ikke logge opslaget:", logFejl.message);
      return { fejl: "Opslaget kunne ikke logges, så oplysningerne vises ikke. Prøv igen om lidt." };
    }
    return { ok: true, data: { juridiskNavn: v.juridisk_navn, foedselsdato: v.foedselsdato } };
  } catch (err) {
    unstable_rethrow(err);
    console.error("visMitIdOplysninger fejlede:", err);
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
