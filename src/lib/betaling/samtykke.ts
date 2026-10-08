// Samtykketeksten til automatisk betaling (Niels M04). Teksten vises ved
// afkrydsningsfeltet under Min konto (KontoBetaling), og versionen gemmes på
// betalingsprofilen, når brugeren slår automatisk betaling til
// (betalingsprofiler.autobetaling_samtykke_version; tidspunktet sætter
// databasen). Ændres teksten, SKAL versionen skiftes (dato), så det altid kan
// ses, hvilken tekst brugeren sagde ja til. Appen bør vise samme tekst og
// sende samme version.
export const AUTOBETALING_SAMTYKKE = {
  version: "2026-10-08",
  overskrift: "Betal automatisk, når jeg vinder",
  tekst: "Tilvalg: Vinder du, trækkes totalprisen på dit gemte kort. Du kan slå det fra når som helst.",
} as const;
