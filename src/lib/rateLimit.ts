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
  // Noeglen er e-mail + IP, saa en fremmed ikke kan laase en bruger ude ved
  // at hamre loes paa hans e-mail fra sin egen IP.
  login_email_ip: { maks: 8, vindueSek: 15 * 60 },
  opret_ip: { maks: 5, vindueSek: 60 * 60 },
  nulstil_ip: { maks: 5, vindueSek: 60 * 60 },
  nulstil_email: { maks: 3, vindueSek: 60 * 60 },
  gensend_ip: { maks: 5, vindueSek: 60 * 60 },
  // Bekræftelsesmail ved oprettelse/gensend pr. e-mail. Supabase har
  // desuden sin egen ventetid mellem to mails.
  gensend_email: { maks: 4, vindueSek: 60 * 60 },
  // Koder til to-trins-login (login, slå til/fra, ny adgangskode).
  mfa_bruger: { maks: 10, vindueSek: 15 * 60 },
  mfa_ip: { maks: 30, vindueSek: 15 * 60 },
  // Tjek af nuværende adgangskode (skift adgangskode, slet konto) og
  // ny adgangskode efter nulstilling.
  adgangskode_bruger: { maks: 6, vindueSek: 15 * 60 },
  konto_slet_bruger: { maks: 5, vindueSek: 60 * 60 },
  // Enheder: fjern enhed / log ud andre steder.
  enheder_bruger: { maks: 30, vindueSek: 15 * 60 },
  venteliste_ip: { maks: 5, vindueSek: 60 * 60 },
  bud_bruger: { maks: 20, vindueSek: 60 },
  bud_ip: { maks: 40, vindueSek: 60 },
  // Spørg sælger. Databasen har sine egne grænser pr. bruger
  // (stil_spoergsmaal), som også gælder appen; dette er et ekstra IP-loft.
  spoergsmaal_ip: { maks: 30, vindueSek: 60 * 60 },
  // Fejlrapporter fra browserens error boundaries (/admin/drift). Derudover
  // et globalt loft på 30 nye pr. minut i drift_fejl_log.
  drift_fejl_ip: { maks: 10, vindueSek: 60 },
  // Kontaktformularen (/kontakt). Derudover honeypot og et globalt loft.
  kontakt_ip: { maks: 5, vindueSek: 60 * 60 },
  kontakt_bruger: { maks: 5, vindueSek: 60 * 60 },
  kontakt_email: { maks: 5, vindueSek: 60 * 60 },
  kontakt_alle: { maks: 300, vindueSek: 60 * 60 },
} satisfies Record<string, Graense>;

export type GraenseNavn = keyof typeof GRAENSER;

// Klientens IP.
// KUN SIKKERT BAG VERCEL: Vercel overskriver x-vercel-forwarded-for og
// x-real-ip med den rigtige klient-IP, saa klienten ikke kan forfalske dem.
// x-forwarded-for bruges kun som sidste udvej (foerste vaerdi), da en klient
// selv kan saette vaerdier i den. Koerer siden et andet sted (egen proxy),
// skal denne funktion gennemgaas igen.
export async function klientIp(): Promise<string> {
  const h = await headers();
  const vercel = h.get("x-vercel-forwarded-for")?.split(",")[0].trim();
  if (vercel) return vercel;
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = h.get("x-forwarded-for")?.split(",")[0].trim();
  return fwd || "ukendt";
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
      console.error(`[rate-limit] fejl – slipper igennem (${navn}):`, error.message);
      return true;
    }
    return data !== false;
  } catch (err) {
    console.error(`[rate-limit] fejl – slipper igennem (${navn}):`, err);
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
