"use server";

import { assertRole } from "@/lib/adminAuth";

// Brugervælgeren på /admin/medarbejder-log (Filip, 13. okt. 2026): staff
// skriver navn, e-mail eller telefon, vælger brugeren på listen, og kun
// brugerens id kommer i adresselinjen (?bruger=<id>). Søgeteksten sendes som
// POST-body til denne action og må aldrig logges (kan være en e-mail).

export type LogBrugerTraef = { id: string; navn: string; under: string };

export async function soegLogBruger(raa: string): Promise<{ traef: LogBrugerTraef[] } | { fejl: string }> {
  let admin;
  try {
    ({ admin } = await assertRole("medarbejder"));
  } catch {
    return { fejl: "Du har ikke adgang." };
  }
  const q = (typeof raa === "string" ? raa : "").trim().slice(0, 120);
  if (q.length < 2) return { traef: [] };

  const { data, error } = await admin.rpc("admin_brugere_soeg", { p_q: q, p_filter: null, p_graense: 8 });
  if (error) {
    // Uden søgeteksten.
    console.error("Medarbejder-log: brugersøgning fejlede:", error.message);
    return { fejl: "Søgningen virker ikke lige nu. Prøv igen om lidt." };
  }
  const traef = ((data ?? []) as { id: string; navn: string | null; email: string | null }[]).map((u) => ({
    id: u.id,
    navn: u.navn ?? "Uden navn",
    under: u.email ?? "",
  }));
  return { traef };
}
