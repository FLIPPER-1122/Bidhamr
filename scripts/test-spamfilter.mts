// Test af chattens spamfilter i TypeScript (spamGrund og erMistaenkeligBesked
// i src/lib/tryghed.ts). Samme eksempler som testblokken sidst i
// supabase/migrations/20261017030000_vilkaar_efternavn_chat.sql - ændres en
// regel, SKAL begge steder rettes.
//
// Kørsel (Node 24 kører TypeScript direkte):
//   node scripts/test-spamfilter.mts
// Afslutter med kode 1, hvis et eksempel fejler.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as TryghedModul from "../src/lib/tryghed";

const sti = pathToFileURL(path.resolve(import.meta.dirname, "../src/lib/tryghed.ts")).href;
const { spamGrund, erMistaenkeligBesked } = (await import(sti)) as typeof TryghedModul;

const SPAM: [string, string | null][] = [
  // Bank: skal stoppes.
  ["reg 1234 konto 12345678", "bank"],
  ["Reg.nr. 1234 kontonr. 0012345678", "bank"],
  ["regnr: 5301 og kontonummer 0123456789", "bank"],
  ["Registreringsnummer 9570 konto 12345678", "bank"],
  ["Du kan overføre til 1234-12345678", "bank"],
  ["1234 - 1234567890", "bank"],
  ["Overfør til min konto 1234 1234567", "bank"],
  ["1234 konto 7654321", "bank"],
  ["kontonr 1234567890, reg 1234", "bank"],
  ["IBAN: DK50 0040 0440 1162 43", "bank"],
  ["dk5000400440116243", "bank"],
  ["iban se45 5000 0000 0583 9825 7466", "bank"],
  // MobilePay (som før).
  ["mobilepay 2234 5678", "mobilepay"],
  ["MobilePay box 12345", "mobilepay"],
  ["send på mp 22 34 56 78", "mobilepay"],
  // Ikke bank: må IKKE stoppes.
  ["Model 1234-567890 virker fint", null],
  ["Kontonr 1234567890", null],
  ["Varenr 1234-123456", null],
  ["Ordrenr 2024 1234", null],
  ["Prisen er 1234 kr", null],
  ["Den er fra 2019-2020", null],
  ["Pakken vejer 1234 gram", null],
  ["Jeg har en konto hos Stripe", null],
  ["Regningen er på 1234 kr", null],
  ["sporing 00370730253300123456", null],
  ["EAN 5701234567890", null],
  ["Den kostede 2500 i 2019", null],
  ["Jeg betaler med MobilePay", null],
  // Telefon (uændret).
  ["22345678", "telefon"],
  ["Tlf. 2234 5678", "telefon"],
];

const MISTAENKELIG: [string, boolean][] = [
  // Advarsel (markeres til staff): skal fanges.
  ["Kan jeg ikke bare betale kontant ved afhentning?", true],
  ["Jeg har kontanter med, når jeg afhenter", true],
  ["Ved afhentning betaler jeg kontant", true],
  ["Kontantbetaling er fint", true],
  ["Lad os betale uden om BidHamr", true],
  ["Vi kan handle uden for siden", true],
  ["Du kan bare overføre til min konto", true],
  ["Overfør til mig i stedet", true],
  ["Du kan overføre beløbet på MobilePay", true],
  ["Bankoverførsel er nemmest", true],
  ["Mobilepay mig bare", true],
  ["Send pengene på mobilepay", true],
  ["Beløbet via Swish", true],
  ["Betal på mobilepay uden gebyr", true],
  ["Kan du betale mig direkte?", true],
  // Ingen advarsel: almindelige beskeder.
  ["Jeg betaler med MobilePay i checkout", false],
  ["MobilePay virker ikke på min telefon", false],
  ["Hvornår kan jeg afhente varen?", false],
  ["Tak for handlen, pengene er overført af BidHamr", false],
  ["Jeg har betalt nu", false],
  ["Varen er sendt med GLS", false],
  ["Kan du sende den i morgen?", false],
];

let fejl = 0;
for (const [tekst, forventet] of SPAM) {
  const fik = spamGrund(tekst);
  if (fik !== forventet) {
    fejl++;
    console.error(`spamGrund(${JSON.stringify(tekst)}): forventet ${forventet}, fik ${fik}`);
  }
}
for (const [tekst, forventet] of MISTAENKELIG) {
  const fik = erMistaenkeligBesked(tekst);
  if (fik !== forventet) {
    fejl++;
    console.error(`erMistaenkeligBesked(${JSON.stringify(tekst)}): forventet ${forventet}, fik ${fik}`);
  }
}

if (fejl > 0) {
  console.error(`${fejl} eksempler fejlede.`);
  process.exit(1);
}
console.log(`Alle ${SPAM.length + MISTAENKELIG.length} eksempler bestod.`);
