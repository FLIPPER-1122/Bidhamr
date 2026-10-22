import "server-only";

// Tællere til admin-lamperne "Reklamationer" (samme regler som databasens
// fragt_reklamationer_antal(), men med service-role, så admin-sider, der
// bruger createAdminClient(), kan vise dem). Kalderen har tjekket staff-adgang;
// chefens tal (venterUdbetaling, udbetalingFejl) vises kun for chefen.
// Kaster aldrig: ved fejl (fx migrationen ikke kørt) gives null.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  REKLAMATION_ANMELD_ROED_DAGE,
  REKLAMATION_STILLE_DAGE,
  REKLAMATION_UDBETALING_HAENGER_MIN,
  type ReklamationTal,
} from "@/lib/reklamation/typer";

const DAG = 24 * 3600 * 1000;

// PostgREST-filter for "udbetalingen hænger/er fejlet" (som databasen).
export function udbetalingFejlFilter(nu: number): string {
  const transfer = new Date(nu - REKLAMATION_UDBETALING_HAENGER_MIN * 60_000).toISOString();
  const time = new Date(nu - 3600_000).toISOString();
  const uge = new Date(nu - 7 * DAG).toISOString();
  return [
    `and(status.eq.godkendt,udbetaling_paabegyndt_kl.lt."${transfer}")`,
    `and(status.eq.udbetalt,bank_status.in.(failed,canceled))`,
    `and(status.eq.udbetalt,transfer_tilbagefoert_kl.not.is.null)`,
    `and(status.eq.udbetalt,bank_status.is.null,udbetalt_kl.lt."${time}")`,
    `and(status.eq.udbetalt,bank_status.eq.claimet,bank_claimet_kl.lt."${time}")`,
    `and(status.eq.udbetalt,bank_status.eq.oprettet,bank_oprettet_kl.lt."${uge}")`,
  ].join(",");
}

export async function hentReklamationTal(admin: SupabaseClient): Promise<ReklamationTal | null> {
  try {
    const nu = Date.now();
    const roed = new Date(nu - REKLAMATION_ANMELD_ROED_DAGE * DAG).toISOString();
    const stille = new Date(nu - REKLAMATION_STILLE_DAGE * DAG).toISOString();
    const antal = () => admin.from("fragt_reklamationer").select("id", { count: "exact", head: true });
    const [a, r, s, g, v, f] = await Promise.all([
      antal().eq("status", "afventer_bidhamr"),
      antal().eq("status", "afventer_bidhamr").lt("aktiv_fra_kl", roed),
      antal().eq("status", "anmeldt").lt("fremdrift_kl", stille),
      antal().in("status", ["anmeldt", "godkendt"]).not("sag_aendret_kl", "is", null).is("sag_aendret_kvitteret_kl", null),
      antal().eq("status", "godkendt"),
      antal().or(udbetalingFejlFilter(nu)),
    ]);
    if (a.error || r.error || s.error || g.error || v.error || f.error) return null;
    return {
      afventer: a.count ?? 0,
      afventerRoed: r.count ?? 0,
      stille: s.count ?? 0,
      sagAendret: g.count ?? 0,
      venterUdbetaling: v.count ?? 0,
      udbetalingFejl: f.count ?? 0,
    };
  } catch {
    return null;
  }
}
