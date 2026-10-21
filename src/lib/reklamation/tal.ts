import "server-only";

// Tællere til admin-lampen "Reklamationer" (samme regler som databasens
// fragt_reklamationer_antal(), men med service-role, så admin-sider, der
// bruger createAdminClient(), kan vise dem). Kalderen har tjekket staff-adgang.
// Kaster aldrig: ved fejl (fx migrationen ikke kørt) gives null.
import type { SupabaseClient } from "@supabase/supabase-js";
import { REKLAMATION_STILLE_DAGE, type ReklamationTal } from "@/lib/reklamation/typer";

export async function hentReklamationTal(admin: SupabaseClient): Promise<ReklamationTal | null> {
  try {
    const graense = new Date(Date.now() - REKLAMATION_STILLE_DAGE * 24 * 3600 * 1000).toISOString();
    const [a, s, g] = await Promise.all([
      admin.from("fragt_reklamationer").select("id", { count: "exact", head: true }).eq("status", "afventer_saelger"),
      admin
        .from("fragt_reklamationer")
        .select("id", { count: "exact", head: true })
        .in("status", ["afventer_saelger", "anmeldt"])
        .lt("fremdrift_kl", graense),
      admin
        .from("fragt_reklamationer")
        .select("id", { count: "exact", head: true })
        .in("status", ["anmeldt", "godkendt"])
        .not("sag_aendret_kl", "is", null)
        .is("sag_aendret_kvitteret_kl", null),
    ]);
    if (a.error || s.error || g.error) return null;
    return { afventerSaelger: a.count ?? 0, stille: s.count ?? 0, sagAendret: g.count ?? 0 };
  } catch {
    return null;
  }
}
