import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import type { Sektion } from "@/lib/driftData";

// Cookiefri besøgsstatistik til /admin/drift. Kaldes kun efter rolle-tjek med
// service-role-klienten derfra (besoegsstatistik() er kun service_role).

type Admin = ReturnType<typeof createAdminClient>;

export type Besoeg = {
  iDag: number;
  dage7: number;
  dage30: number;
  top: { sti: string; antal: number }[];
  prDag: { dag: string; antal: number }[];
};

function tal(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function hentBesoeg(admin: Admin, dage: number): Promise<Sektion<Besoeg>> {
  const { data, error } = await admin.rpc("besoegsstatistik", { p_dage: dage, p_top: 15 });
  if (error) {
    if (["42883", "42P01", "PGRST202", "PGRST205"].includes(error.code ?? "")) return { tilstand: "mangler" };
    return { tilstand: "fejl", besked: error.message };
  }
  const d = (data ?? {}) as Record<string, unknown>;
  const liste = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return {
    tilstand: "ok",
    data: {
      iDag: tal(d.i_dag),
      dage7: tal(d.dage_7),
      dage30: tal(d.dage_30),
      top: liste(d.top).map((r) => ({ sti: String(r.sti ?? ""), antal: tal(r.antal) })),
      prDag: liste(d.pr_dag).map((r) => ({ dag: String(r.dag ?? ""), antal: tal(r.antal) })),
    },
  };
}

// Læsbare navne til de normaliserede stier (src/lib/statistikSti.ts).
const NAVNE: Record<string, string> = {
  "/": "Forsiden",
  "/coming-soon": "Venteliste-siden",
  "/auktioner": "Alle auktioner / søgning",
  "/auktion/[id]": "En auktion",
  "/auktion/[id]/rediger": "Redigér auktion",
  "/opret-auktion": "Opret auktion",
  "/profil/[id]": "En profil",
  "/mine-handler": "Mine handler",
  "/mine-handler/[id]": "En handel",
  "/beskeder": "Beskeder",
  "/ukendt": "Ukendt side (404)",
};

export function stiNavn(sti: string): string {
  return NAVNE[sti] ?? sti;
}
