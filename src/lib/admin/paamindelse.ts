import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";

// Hvornår har staff sidst skrevet til en part om en handel? Bruges til
// spærren på "Send påmindelse" (24 timer) og til teksten "Påmindelse sendt for
// X t siden" på Handler. Kun efter assertRole/kraevSideRolle.

type Admin = ReturnType<typeof createAdminClient>;

// Seneste staff-besked til brugeren om handlen (eller null).
export async function sidsteStaffBeskedOmHandel(
  admin: Admin,
  par: { tradeId: string; brugerId: string }[],
): Promise<Map<string, string>> {
  const ud = new Map<string, string>();
  if (par.length === 0) return ud;
  // aabnChat lægger en besked i en ÅBEN samtale med brugeren - også en
  // generel samtale uden handel. Derfor tæller både samtaler om handlen og
  // generelle samtaler med parten (hellere spærre én gang for meget; staff
  // kan altid vælge "Send alligevel").
  const { data: samtaler, error } = await admin
    .from("staff_samtaler")
    .select("id, bruger_id, trade_id")
    .in("bruger_id", [...new Set(par.map((p) => p.brugerId))])
    .limit(1000);
  if (error) {
    console.error("Påmindelser: staff_samtaler kunne ikke hentes:", error.message);
    return ud;
  }
  const relevante = ((samtaler ?? []) as { id: string; bruger_id: string; trade_id: string | null }[]).filter((s) =>
    par.some((p) => p.brugerId === s.bruger_id && (s.trade_id === null || s.trade_id === p.tradeId)),
  );
  if (relevante.length === 0) return ud;
  const { data: beskeder, error: bFejl } = await admin
    .from("staff_beskeder")
    .select("samtale_id, oprettet_kl")
    .in("samtale_id", relevante.map((s) => s.id))
    .eq("fra_staff", true)
    .order("oprettet_kl", { ascending: false })
    .limit(1000);
  if (bFejl) {
    console.error("Påmindelser: staff_beskeder kunne ikke hentes:", bFejl.message);
    return ud;
  }
  const samtale = new Map(relevante.map((s) => [s.id, s]));
  // Beskederne kommer nyeste først - den første pr. par er den seneste.
  for (const b of (beskeder ?? []) as { samtale_id: string; oprettet_kl: string }[]) {
    const s = samtale.get(b.samtale_id);
    if (!s) continue;
    for (const p of par) {
      if (p.brugerId !== s.bruger_id || (s.trade_id !== null && s.trade_id !== p.tradeId)) continue;
      const n = `${p.tradeId}:${p.brugerId}`;
      if (!ud.has(n)) ud.set(n, b.oprettet_kl);
    }
  }
  return ud;
}

