import "server-only";

// Grænse for staffs ZIP-hentning af reklamationspakken
// (/admin/reklamationer/<id>/billeder): 60 ZIP'er i timen pr. medarbejder.
// Grænsen fejler LUKKET: kan den ikke tjekkes, afvises kaldet (429).
// (Sælgeren har ingen ruter til pakken - Filip, 22. okt. 2026.)
import { createAdminClient } from "@/lib/supabase/admin";

const GRAENSE = { maks: 60, vindueSek: 60 * 60 };

// true = inden for grænsen. Fejler lukket (false), hvis grænsen ikke kan tjekkes.
export async function reklamationZipIndenForGraense(staffId: string): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient().rpc("rate_limit_tjek", {
      p_noegle: `reklamation_staff_zip:${staffId}`,
      p_maks: GRAENSE.maks,
      p_vindue_sek: GRAENSE.vindueSek,
    });
    if (error) {
      console.error("Reklamation: rate_limit_tjek fejlede:", error.message);
      return false;
    }
    return data === true;
  } catch (err) {
    console.error("Reklamation: rate_limit_tjek kastede:", err);
    return false;
  }
}

export const FOR_MANGE = "Du har hentet mange gange på kort tid. Vent lidt, og prøv igen.";
