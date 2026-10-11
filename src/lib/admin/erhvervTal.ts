import "server-only";

import { cache } from "react";
import type { createAdminClient } from "@/lib/supabase/admin";
import { antalAabneFirmaDsaKlager } from "@/lib/dsa/firmaKlager";

// Antal til Erhvervs "Kræver handling" (chefens forside og sælgerens
// oversigt). KUN antal - ingen beløb eller persondata. Kaldes kun efter
// kraevErhvervSide()/getErhvervRolle() (chef eller sælger). Fejl giver 0.

type Admin = ReturnType<typeof createAdminClient>;

export type ErhvervTal = {
  nyeHenvendelser: number;
  aabneKlager: number;
  klagerUnderBehandling: number;
  dsaKlager: number;
  advarselForslag: number;
  lukningForslag: number;
};

const tael = (r: { count: number | null; error: unknown }) => (r.error ? 0 : (r.count ?? 0));

export const hentErhvervTal = cache(async (admin: Admin): Promise<ErhvervTal> => {
  const [henv, aabne, igang, forslag, lukning, dsa] = await Promise.all([
    admin
      .from("erhverv_henvendelser")
      .select("id", { count: "exact", head: true })
      .eq("status", "ny")
      .is("arkiveret_kl", null),
    admin.from("erhverv_klager").select("id", { count: "exact", head: true }).eq("status", "aaben"),
    admin.from("erhverv_klager").select("id", { count: "exact", head: true }).eq("status", "under_behandling"),
    admin.from("erhverv_advarsel_forslag").select("id", { count: "exact", head: true }).eq("status", "afventer"),
    // Forslag om kontolukning, der gælder en firmakonto.
    admin
      .from("konto_lukning_forslag")
      .select("id, bruger:users!konto_lukning_forslag_bruger_id_fkey!inner(konto_type)", { count: "exact", head: true })
      .eq("status", "afventer")
      .eq("bruger.konto_type", "erhverv"),
    antalAabneFirmaDsaKlager(admin),
  ]);
  return {
    nyeHenvendelser: tael(henv),
    aabneKlager: tael(aabne),
    klagerUnderBehandling: tael(igang),
    dsaKlager: dsa,
    advarselForslag: tael(forslag),
    lukningForslag: tael(lukning),
  };
});
