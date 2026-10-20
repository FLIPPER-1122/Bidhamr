import "server-only";

import { erTestdatabase } from "@/lib/miljoe";
import type { DineroKonfig } from "./dinero";

// Dinero-opsætning fra miljøvariablerne (aldrig i klient-kode eller git):
//   DINERO_CLIENT_ID, DINERO_CLIENT_SECRET  - "personlig integration" i Dinero
//   DINERO_API_KEY                          - API-nøglen for organisationen
//   DINERO_ORG_ID                           - organisationens id (tal)
//   DINERO_LIVE_ORG_ID BidHamrs rigtige regnskabs id. Med DINERO_MILJOE=live
//                      SKAL DINERO_ORG_ID være netop det (ellers ingen
//                      fakturaer); i test må DINERO_ORG_ID aldrig være det.
//   DINERO_MILJOE      test | live (standard test). Testdatabasen må aldrig
//                      bruge live. Produktionsdatabasen kræver live - eller
//                      udtrykkeligt test, så længe Stripe kører med
//                      testnøgle (så er betalingerne heller ikke rigtige).
//                      I test skal regnskabet hedde "BidHamr Test..." og må
//                      ikke have BidHamrs CVR (kontrollerOrganisation, tjekkes
//                      hos Dinero før hver kørsel).
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
  // Tom (fx "DINERO_MILJOE=" fra .env.example) = standard test.
  const miljoeRaa = (process.env.DINERO_MILJOE ?? "").trim().toLowerCase() || "test";
  if (miljoeRaa !== "test" && miljoeRaa !== "live") {
    return { ok: false, grund: "ugyldig", besked: "DINERO_MILJOE skal være 'test' eller 'live'." };
  }
  const miljoe = miljoeRaa as "test" | "live";
  const test = erTestdatabase();
  if (test && miljoe === "live") {
    return { ok: false, grund: "forkert_miljoe", besked: "Testdatabasen må ikke bruge Dineros live-regnskab (DINERO_MILJOE=live)." };
  }
  if (!test && miljoe !== "live") {
    // Produktionen må bruge Dineros testregnskab ("BidHamr Test"), så længe
    // den kører med Stripes TESTnøgle (fase 6) - så er betalingerne heller
    // ikke rigtige. Det skal vælges udtrykkeligt (DINERO_MILJOE=test); en
    // tom værdi giver ingen fakturaer. Med Stripes live-nøgle kræves live.
    const eksplicit = (process.env.DINERO_MILJOE ?? "").trim().toLowerCase() === "test";
    if (!eksplicit || !stripeTestnoegle()) {
      return {
        ok: false,
        grund: "forkert_miljoe",
        besked: eksplicit
          ? "Produktionen kører med Stripes live-nøgle og kræver DINERO_MILJOE=live (ellers ville rigtige kunder havne i Dineros testregnskab)."
          : "Produktionsdatabasen kræver DINERO_MILJOE=live - eller DINERO_MILJOE=test (testregnskabet \"BidHamr Test\"), så længe Stripe kører med testnøgle.",
      };
    }
  }
  // Låst org-id for live: en forkert nøgle/org (fx sandkassen i Vercel)
  // kan aldrig få rigtige kunders fakturaer - og testen aldrig ramme live.
  const liveOrg = (process.env.DINERO_LIVE_ORG_ID ?? "").trim();
  if (miljoe === "live" && (!/^[0-9]{1,12}$/.test(liveOrg) || liveOrg !== orgId)) {
    return {
      ok: false,
      grund: "forkert_miljoe",
      besked: "DINERO_MILJOE=live kræver, at DINERO_ORG_ID er det samme som DINERO_LIVE_ORG_ID (BidHamrs rigtige regnskab).",
    };
  }
  if (miljoe === "test" && liveOrg && liveOrg === orgId) {
    return { ok: false, grund: "forkert_miljoe", besked: "Testmiljøet må ikke bruge BidHamrs rigtige regnskab (DINERO_LIVE_ORG_ID)." };
  }
  const salg = konto("DINERO_KONTO_SALG", 1000);
  const fragt = konto("DINERO_KONTO_FRAGT", 1350);
  const indbetaling = konto("DINERO_KONTO_INDBETALING", 55000);
  if (salg === null || fragt === null || indbetaling === null) {
    return { ok: false, grund: "ugyldig", besked: "DINERO_KONTO_* skal være kontonumre (kun tal)." };
  }
  return { ok: true, dinero: { clientId, clientSecret, apiKey, orgId }, konti: { salg, fragt, indbetaling }, miljoe };
}

// Samme regel som noeglensTilstand() i src/lib/stripe.ts (her uden at hente
// Stripe-klienten ind): kun en udtrykkelig testnøgle tæller.
function stripeTestnoegle(): boolean {
  return /^(sk|rk)_test_/.test((process.env.STRIPE_SECRET_KEY ?? "").trim());
}

// BidHamrs CVR - live-regnskabet i Dinero skal have det, testregnskabet må
// aldrig have det (ROADMAP-BESLUTNINGER "Virksomhedsoplysninger").
export const BIDHAMR_CVR = "46836219";
// Dineros testregnskab hedder "BidHamr Test" (Filip, 20. okt. 2026: fakturaer
// må i test KUN sendes dertil - aldrig til "Bidhamr ApS", det rigtige
// regnskab). Et særskilt testregnskab til produktionen skal også starte med
// "BidHamr Test" (fx "BidHamr Test Produktion").
export const TEST_ORG_NAVN = "BidHamr Test";

export type DineroOrganisation = { Id: number | string; Name: string | null; VatNumber: string | null };

const normNavn = (s: string | null | undefined) => (s ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

// Er Dinero-regnskabet det rigtige for miljøet? null = ja, ellers hvorfor
// ikke. Kaldes før hver kørsel af fakturakøen med regnskabet, som Dinero selv
// oplyser for nøglen (GET /v1.1/organizations) - så en forkert nøgle eller et
// forkert DINERO_ORG_ID aldrig sender noget.
//   live: regnskabet skal have BidHamrs CVR.
//   test: regnskabet skal hedde "BidHamr Test..." og må ikke have BidHamrs
//         CVR (DINERO_LIVE_ORG_ID er allerede afvist i hentFakturaKonfig).
export function kontrollerOrganisation(
  miljoe: "test" | "live",
  orgId: string,
  org: DineroOrganisation | null,
): string | null {
  if (!org || String(org.Id) !== orgId) {
    return `Dinero-regnskabet ${orgId} findes ikke for nøglen (DINERO_ORG_ID).`;
  }
  const cvr = (org.VatNumber ?? "").replace(/\D/g, "");
  if (miljoe === "live") {
    return cvr === BIDHAMR_CVR ? null : `Dinero-regnskabet ${orgId} har ikke BidHamrs CVR (${BIDHAMR_CVR}).`;
  }
  if (cvr === BIDHAMR_CVR) {
    return `Dinero-regnskabet ${orgId} har BidHamrs CVR - testmiljøet må aldrig sende til BidHamrs rigtige regnskab.`;
  }
  const navn = normNavn(org.Name);
  const krav = normNavn(TEST_ORG_NAVN);
  if (navn !== krav && !navn.startsWith(`${krav} `)) {
    return `Dinero-regnskabet ${orgId} hedder ikke "${TEST_ORG_NAVN}" - testmiljøet sender kun til Dineros testregnskab.`;
  }
  return null;
}
