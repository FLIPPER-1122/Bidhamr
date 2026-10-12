import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";

// Hvornår har staff sidst skrevet til en part om en handel? Bruges til
// spærren på "Send påmindelse" (24 timer) og til teksten "Påmindelse sendt for
// X t siden" på Handler. Kun efter assertRole/kraevSideRolle.

type Admin = ReturnType<typeof createAdminClient>;

// null = databasen fejlede (vi ved det ikke).
// Seneste staff-besked til brugeren om handlen (eller null).
export async function sidsteStaffBeskedOmHandel(
  admin: Admin,
  par: { tradeId: string; brugerId: string }[],
): Promise<Map<string, string> | null> {
  const ud = new Map<string, string>();
  if (par.length === 0) return ud;
  // Kun samtaler, der er knyttet til den konkrete handel (trade_id). En
  // generel samtale med parten spærrer ikke - den hører ikke til en handel.
  // Påmindelser oprettes altid i en samtale for handlen (sendPaamindelse).
  const { data: samtaler, error } = await admin
    .from("staff_samtaler")
    .select("id, bruger_id, trade_id")
    .in("trade_id", [...new Set(par.map((p) => p.tradeId))])
    .limit(1000);
  if (error) {
    console.error("Påmindelser: staff_samtaler kunne ikke hentes:", error.message);
    return null;
  }
  const relevante = ((samtaler ?? []) as { id: string; bruger_id: string; trade_id: string }[]).filter((s) =>
    par.some((p) => p.brugerId === s.bruger_id && p.tradeId === s.trade_id),
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
    return null;
  }
  const samtale = new Map(relevante.map((s) => [s.id, `${s.trade_id}:${s.bruger_id}`]));
  // Nyeste først - den første pr. par er den seneste.
  for (const b of (beskeder ?? []) as { samtale_id: string; oprettet_kl: string }[]) {
    const n = samtale.get(b.samtale_id);
    if (n && !ud.has(n)) ud.set(n, b.oprettet_kl);
  }
  return ud;
}

