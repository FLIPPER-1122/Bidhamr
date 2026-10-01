import "server-only";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";

// Lille Postgres-baseret rate limiter (tabel rate_limits + funktionen
// rate_limit_tjek, kun service_role). Ingen betalt tjeneste.
//
// Fast tidsvindue: hver noegle maa bruges hoejst `maks` gange pr. `vindueSek`.
// Fejler databasen, slippes forespoergslen igennem (fail open), saa en fejl
// her ikke laaser alle ude - Supabase Auth har desuden sine egne graenser.

export const FOR_MANGE_FORSOEG =
  "Du har prøvet for mange gange. Vent lidt, og prøv så igen.";

export type Graense = { maks: number; vindueSek: number };

export const GRAENSER = {
  login_ip: { maks: 20, vindueSek: 15 * 60 },
  login_email: { maks: 8, vindueSek: 15 * 60 },
  opret_ip: { maks: 5, vindueSek: 60 * 60 },
  nulstil_ip: { maks: 5, vindueSek: 60 * 60 },
  nulstil_email: { maks: 3, vindueSek: 60 * 60 },
  gensend_ip: { maks: 5, vindueSek: 60 * 60 },
  venteliste_ip: { maks: 5, vindueSek: 60 * 60 },
  bud_bruger: { maks: 20, vindueSek: 60 },
  bud_ip: { maks: 40, vindueSek: 60 },
} satisfies Record<string, Graense>;

export type GraenseNavn = keyof typeof GRAENSER;

// Klientens IP. Paa Vercel saettes x-forwarded-for af platformen; foerste
// vaerdi er klienten.
export async function klientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip")?.trim() || "ukendt";
}

// Returnerer true, hvis forespoergslen er inden for graensen.
export async function indenForGraense(navn: GraenseNavn, id: string): Promise<boolean> {
  const g = GRAENSER[navn];
  try {
    const { data, error } = await createAdminClient().rpc("rate_limit_tjek", {
      p_noegle: `${navn}:${id.toLowerCase()}`,
      p_maks: g.maks,
      p_vindue_sek: g.vindueSek,
    });
    if (error) {
      console.error("rate_limit_tjek fejlede:", error.message);
      return true;
    }
    return data !== false;
  } catch (err) {
    console.error("rate_limit_tjek fejlede:", err);
    return true;
  }
}

// Tjekker flere graenser; alle skal vaere overholdt.
export async function tjekGraenser(
  tjek: [GraenseNavn, string][],
): Promise<boolean> {
  const svar = await Promise.all(tjek.map(([n, id]) => indenForGraense(n, id)));
  return svar.every(Boolean);
}
