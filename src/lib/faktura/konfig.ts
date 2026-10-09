import "server-only";

import { erTestdatabase } from "@/lib/miljoe";
import type { DineroKonfig } from "./dinero";

// Dinero-opsætning fra miljøvariablerne (aldrig i klient-kode eller git):
//   DINERO_CLIENT_ID, DINERO_CLIENT_SECRET  - "personlig integration" i Dinero
//   DINERO_API_KEY                          - API-nøglen for organisationen
//   DINERO_ORG_ID                           - organisationens id (tal)
//   DINERO_MILJOE      test | live (standard test). Produktionsdatabasen
//                      kræver live, testdatabasen må aldrig bruge live - så
//                      rigtige kunder aldrig havner i sandkassen og omvendt.
//   DINERO_KONTO_SALG         salgskonto m/moms (standard 1000, U25)
//   DINERO_KONTO_FRAGT        salg af fragt, momspligtig (standard 1350, U25)
//   DINERO_KONTO_INDBETALING  konto, betalingerne registreres på (standard
//                             55000 "Bank"; revisoren bør vælge en egen
//                             "Stripe"-konto - se docs/FAKTURA.md)
// Se docs/FAKTURA.md.

export type FakturaKonti = { salg: number; fragt: number; indbetaling: number };

export type FakturaKonfig =
  | { ok: true; dinero: DineroKonfig; konti: FakturaKonti; miljoe: "test" | "live" }
  | { ok: false; grund: "mangler" | "forkert_miljoe" | "ugyldig"; besked: string };

function konto(navn: string, standard: number): number | null {
  const v = (process.env[navn] ?? "").trim();
  if (!v) return standard;
  return /^[0-9]{1,9}$/.test(v) ? Number(v) : null;
}

export function hentFakturaKonfig(): FakturaKonfig {
  const clientId = (process.env.DINERO_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.DINERO_CLIENT_SECRET ?? "").trim();
  const apiKey = (process.env.DINERO_API_KEY ?? "").trim();
  const orgId = (process.env.DINERO_ORG_ID ?? "").trim();
  if (!clientId || !clientSecret || !apiKey || !orgId) {
    return { ok: false, grund: "mangler", besked: "Dinero er ikke sat op (DINERO_CLIENT_ID/SECRET/API_KEY/ORG_ID mangler)." };
  }
  if (!/^[0-9]{1,12}$/.test(orgId)) {
    return { ok: false, grund: "ugyldig", besked: "DINERO_ORG_ID skal være organisationens id (kun tal)." };
  }
  const miljoeRaa = (process.env.DINERO_MILJOE ?? "test").trim().toLowerCase();
  if (miljoeRaa !== "test" && miljoeRaa !== "live") {
    return { ok: false, grund: "ugyldig", besked: "DINERO_MILJOE skal være 'test' eller 'live'." };
  }
  const miljoe = miljoeRaa as "test" | "live";
  const test = erTestdatabase();
  if (test && miljoe === "live") {
    return { ok: false, grund: "forkert_miljoe", besked: "Testdatabasen må ikke bruge Dineros live-regnskab (DINERO_MILJOE=live)." };
  }
  if (!test && miljoe !== "live") {
    return {
      ok: false,
      grund: "forkert_miljoe",
      besked: "Produktionsdatabasen kræver DINERO_MILJOE=live (ellers ville rigtige kunder havne i Dineros testregnskab).",
    };
  }
  const salg = konto("DINERO_KONTO_SALG", 1000);
  const fragt = konto("DINERO_KONTO_FRAGT", 1350);
  const indbetaling = konto("DINERO_KONTO_INDBETALING", 55000);
  if (salg === null || fragt === null || indbetaling === null) {
    return { ok: false, grund: "ugyldig", besked: "DINERO_KONTO_* skal være kontonumre (kun tal)." };
  }
  return { ok: true, dinero: { clientId, clientSecret, apiKey, orgId }, konti: { salg, fragt, indbetaling }, miljoe };
}
