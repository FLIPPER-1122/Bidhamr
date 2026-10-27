// Tekster til sælgerens handelsside (/mine-handler/[trade_id] og
// /firma/salg/[trade_id] - src/components/handel/HandelDetalje.tsx).

// Bankindsigelse (chargeback) på betalingen: varen må ikke sendes eller
// udleveres. Databasen afviser også "Marker som sendt" og en ny fragtlabel
// (kode 'indsigelse', 20261102080000_handel_testfund.sql).
export const INDSIGELSE_SAELGER = {
  aabenTitel: "Indsigelse fra køberens bank",
  aabenTekst: (afhentning: boolean) =>
    `${afhentning ? "Udlevér ikke varen." : "Send ikke varen."} Køberens bank har åbnet en indsigelse. Vi skriver til dig, når den er afgjort.`,
  tabtTitel: "Køberens bank har afgjort indsigelsen",
  tabtTekst: (afhentning: boolean) =>
    `${afhentning ? "Udlevér ikke varen." : "Send ikke varen."} Banken har givet køberen medhold, og pengene er gået tilbage til køberen. Vi skriver til dig om, hvad der sker nu.`,
  // Har sælgeren allerede lavet en fragtlabel, vises den stadig (så den kan
  // annulleres), men pakken må ikke sendes.
  labelFindes: "Har du allerede lavet en fragtlabel, så send ikke pakken. Du kan annullere labelen herunder.",
} as const;

// Fejl fra "Marker som sendt" og "Lav fragtlabel" (kode 'indsigelse').
export const INDSIGELSE_FEJL =
  "Send ikke varen. Køberens bank har åbnet en indsigelse. Vi skriver til dig, når den er afgjort.";

// Fragtlabels i BidHamr er ikke slået til (FRAGT_LABELS_AKTIV): sælgeren
// kan ikke se køberens adresse eller lave en label her. Skal være slået til
// ved lancering (docs/FRAGT.md, "Go-live").
export const FRAGT_UDEN_LABELS = {
  titel: "Fragtlabelen kommer her",
  // valg: "levering hjem med GLS" / "pakkeshop hos DAO: Navn, Adresse, 8000 Aarhus C".
  tekst: (valg: string | null, doer: boolean) =>
    `${valg ? `Køberen har valgt ${valg}. ` : ""}Fragtlabelen${
      doer ? " med køberens adresse" : ""
    } bliver lavet her på siden, men det er ikke slået til endnu. Send ikke pakken på egen hånd – skriv til support@bidhamr.dk, så hjælper vi dig med labelen.`,
} as const;
