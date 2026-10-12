import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";

// Hvem har taget sagerne ("Tag sagen", 20261020010000_admin_hurtig.sql)?
// Hentes for sig, så Sager stadig virker, hvis migrationen ikke er kørt
// (kolonnen findes ikke -> ingen har taget noget). Kun efter rolletjekket.

type Admin = ReturnType<typeof createAdminClient>;

export type SagTaget = { brugerId: string; navn: string | null; kl: string };

// Er staff inhabil i sagen? Samme regel som databasen bruger ved afgørelse og
// "Tag sagen" (penge_inhabil: part i handlen eller har handlet med en part).
// Fejler kaldet, regnes staff som inhabil (fail closed - knappen skjules, og
// databasen afgør alligevel).
export async function erInhabil(admin: Admin, mig: string, koeber: string | null, saelger: string | null): Promise<boolean> {
  if (!mig) return true;
  if (mig === koeber || mig === saelger) return true;
  const { data, error } = await admin.rpc("penge_inhabil", { p_medarbejder: mig, p_koeber: koeber, p_saelger: saelger });
  if (error) {
    console.error("penge_inhabil fejlede:", error.message);
    return true;
  }
  return data === true;
}

export async function hentSagTaget(admin: Admin, sagIds: string[]): Promise<Map<string, SagTaget>> {
  const ud = new Map<string, SagTaget>();
  if (sagIds.length === 0) return ud;
  const { data, error } = await admin
    .from("sager")
    .select("id, behandles_af, behandles_kl")
    .in("id", sagIds)
    .not("behandles_af", "is", null);
  if (error) {
    if (error.code !== "42703" && error.code !== "PGRST204") console.error("Tag sagen: kunne ikke læses:", error.message);
    return ud;
  }
  const raekker = (data ?? []) as { id: string; behandles_af: string; behandles_kl: string }[];
  const ids = [...new Set(raekker.map((r) => r.behandles_af))];
  const { data: brugere } = ids.length
    ? await admin.from("users").select("id, navn").in("id", ids)
    : { data: [] as { id: string; navn: string | null }[] };
  const navn = new Map((brugere ?? []).map((u) => [u.id as string, (u.navn as string | null) ?? null]));
  for (const r of raekker) ud.set(r.id, { brugerId: r.behandles_af, navn: navn.get(r.behandles_af) ?? null, kl: r.behandles_kl });
  return ud;
}
