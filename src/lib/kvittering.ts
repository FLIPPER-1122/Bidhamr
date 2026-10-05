// Kvittering/handelsbekræftelse for selve varen (ROADMAP fase 5). Varen
// sælges mellem private, så det er IKKE en faktura. BidHamrs fakturaer på
// egne gebyrer kommer senere fra regnskabsprogrammet.
//
// Ingen server-only-import: typerne og opdelingen bruges både af mails
// (server) og af kvitteringsvisningen (server-komponent). Data hentes i
// src/lib/betaling/kvittering.ts.

export const KVITTERING_IKKE_FAKTURA =
  "Varen sælges mellem private. Dette er en kvittering/handelsbekræftelse – ikke en faktura.";
export const KVITTERING_STRIPE = "Betalingen håndteres af vores betalingspartner Stripe.";

// Køberens kvittering: alt, køberen har betalt.
export type KoeberKvittering = {
  rolle: "koeber";
  handelId: string;
  titel: string;
  // Modpartens navn (sælgeren).
  modpartNavn: string;
  // Hvornår betalingen blev modtaget.
  dato: string;
  afhentning: boolean;
  budOere: number;
  koebergebyrOere: number;
  fragtOere: number;
  beskyttelse: boolean;
  beskyttelseOere: number;
  totalOere: number;
  // Sat, når betalingen er refunderet (helt eller delvist).
  refunderetOere: number | null;
  refunderetKl: string | null;
};

// Sælgerens afregning: buddet minus sælgergebyr. Fragten og en evt. BidHamr
// Beskyttelse er køberens og nævnes ikke som sælgerindtægt.
export type SaelgerKvittering = {
  rolle: "saelger";
  handelId: string;
  titel: string;
  // Modpartens navn (køberen).
  modpartNavn: string;
  // Hvornår pengene blev frigivet (handlen afsluttet).
  dato: string;
  afhentning: boolean;
  budOere: number;
  saelgergebyrOere: number;
  udbetalingOere: number;
  overfoertKl: string | null;
};

export type Kvittering = KoeberKvittering | SaelgerKvittering;

export type KvitteringLinje = {
  tekst: string;
  oere: number;
  // Totalen/udbetalingen.
  fremhaev?: boolean;
  // Vises med minus foran (fx sælgergebyr).
  fratraek?: boolean;
};

// Samme opdeling i mail og på handelssiden.
export function kvitteringLinjer(k: Kvittering): KvitteringLinje[] {
  if (k.rolle === "koeber") {
    const linjer: KvitteringLinje[] = [
      { tekst: "Varepris (vindende bud)", oere: k.budOere },
      { tekst: "Købergebyr (5 %)", oere: k.koebergebyrOere },
      { tekst: k.afhentning ? "Fragt (afhentning)" : "Fragt", oere: k.fragtOere },
    ];
    if (k.beskyttelse) linjer.push({ tekst: "BidHamr Beskyttelse", oere: k.beskyttelseOere });
    linjer.push({ tekst: "I alt betalt", oere: k.totalOere, fremhaev: true });
    if (k.refunderetOere !== null) {
      linjer.push({ tekst: "Betalt tilbage til dig", oere: k.refunderetOere, fratraek: true });
    }
    return linjer;
  }
  return [
    { tekst: "Salgspris (vindende bud)", oere: k.budOere },
    { tekst: "Sælgergebyr (5 %)", oere: k.saelgergebyrOere, fratraek: true },
    { tekst: "Udbetaling til dig", oere: k.udbetalingOere, fremhaev: true },
  ];
}

export function kvitteringKroner(oere: number): string {
  return (oere / 100).toLocaleString("da-DK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function kvitteringDato(iso: string): string {
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
