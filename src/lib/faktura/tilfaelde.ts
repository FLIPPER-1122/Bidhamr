import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { KONFIG_ALARM_PRAEFIKS } from "@/lib/admin/fakturaLampe";

// Åbne drift-tilfælde for Dinero (faktura:adgang, faktura:konfiguration) til
// Admin -> Fakturaer. drift_tilfaelde har kun nøglen, så teksten til
// faktura:konfiguration er den seneste alarm i drift_fejl med præfikset fra
// src/lib/faktura/koe.ts (KONFIG_ALARM_PRAEFIKS), set efter tilfældet blev
// åbnet. Alarmteksterne er renset (logDriftFejl) og har ingen nøgler.

type Admin = ReturnType<typeof createAdminClient>;

export const DINERO_TILFAELDE = ["faktura:adgang", "faktura:konfiguration"] as const;

export type FakturaTilfaelde =
  | { ok: true; aabne: string[]; aabnetKl: Record<string, string>; konfigurationTekst: string | null }
  | { ok: false };

const HVOR = "faktura/dinero: ";

export async function hentFakturaTilfaelde(admin: Admin): Promise<FakturaTilfaelde> {
  const { data, error } = await admin
    .from("drift_tilfaelde")
    .select("noegle, aabnet_kl")
    .in("noegle", [...DINERO_TILFAELDE])
    .is("loest_kl", null);
  if (error) return { ok: false };
  const raekker = (data ?? []) as { noegle: string; aabnet_kl: string }[];
  const aabnetKl = Object.fromEntries(raekker.map((r) => [r.noegle, r.aabnet_kl]));
  let konfigurationTekst: string | null = null;
  const fra = aabnetKl["faktura:konfiguration"];
  if (fra) {
    // Lidt før åbningen: alarmen logges lige efter, at tilfældet er åbnet,
    // men urene i databasen og her kan afvige en anelse.
    const efter = new Date(new Date(fra).getTime() - 60_000).toISOString();
    const { data: f } = await admin
      .from("drift_fejl")
      .select("besked")
      .like("besked", `${HVOR}${KONFIG_ALARM_PRAEFIKS}%`)
      .gte("senest_kl", efter)
      .order("senest_kl", { ascending: false })
      .limit(1)
      .maybeSingle<{ besked: string }>();
    const besked = f?.besked ?? "";
    if (besked.startsWith(`${HVOR}${KONFIG_ALARM_PRAEFIKS}`)) {
      konfigurationTekst = besked.slice(`${HVOR}${KONFIG_ALARM_PRAEFIKS}`.length).replace(/\s*Se docs\/FAKTURA\.md\.?\s*$/, "").trim() || null;
    }
  }
  return { ok: true, aabne: raekker.map((r) => r.noegle), aabnetKl, konfigurationTekst };
}
