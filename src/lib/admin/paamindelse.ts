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
  const { data: samtaler, error } = await admin
    .from("staff_samtaler")
    .select("id, bruger_id, trade_id")
    .in("trade_id", [...new Set(par.map((p) => p.tradeId))])
    .limit(500);
  if (error) {
    console.error("Påmindelser: staff_samtaler kunne ikke hentes:", error.message);
    return ud;
  }
  const relevante = ((samtaler ?? []) as { id: string; bruger_id: string; trade_id: string }[]).filter((s) =>
    par.some((p) => p.tradeId === s.trade_id && p.brugerId === s.bruger_id),
  );
  if (relevante.length === 0) return ud;
  const { data: beskeder, error: bFejl } = await admin
    .from("staff_beskeder")
    .select("samtale_id, oprettet_kl")
    .in("samtale_id", relevante.map((s) => s.id))
    .eq("fra_staff", true)
    .order("oprettet_kl", { ascending: false })
    .limit(500);
  if (bFejl) {
    console.error("Påmindelser: staff_beskeder kunne ikke hentes:", bFejl.message);
    return ud;
  }
  const samtale = new Map(relevante.map((s) => [s.id, `${s.trade_id}:${s.bruger_id}`]));
  for (const b of (beskeder ?? []) as { samtale_id: string; oprettet_kl: string }[]) {
    const n = samtale.get(b.samtale_id);
    if (n && !ud.has(n)) ud.set(n, b.oprettet_kl);
  }
  return ud;
}

