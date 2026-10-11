// Admin → Erhverv → Klager over afgørelser (DSA-klager over suspension og
// lukning af en firmakonto). Korte pladsholdertekster - indhold-agenten kan
// finpudse dem.
export const ERHVERV_DSA_KLAGER = {
  fane: "Klager over afgørelser",
  titel: "Klager over afgørelser",
  forklaring:
    "Firmaer, der klager over, at vi har suspenderet eller lukket deres konto (DSA). Svar inden for 14 dage. En klage behandles altid af en anden end den, der traf afgørelsen.",
  filter: { afventer: "Venter", afgjort: "Afgjorte" },
  tom: { afventer: "Der er ingen klager, der venter.", afgjort: "Ingen afgjorte klager endnu." },
  fejl: "Klagerne kunne ikke hentes. Genindlæs siden, eller kontakt en udvikler, hvis det bliver ved.",
  visFlere: "Vis flere",
  tilbage: "Tilbage til klager over afgørelser",
  aaben: "Åbn klagen",
  ikkeFundet: "Klagen findes ikke, eller den handler ikke om en firmakonto.",
  permanent: "Permanent",
  til: (dato: string) => `Til ${dato}`,
  lukket: "Konto lukket",
  suspenderet: "Konto suspenderet",
  medhold: "Medhold",
  fastholdt: "Fastholdt",
  afgjortAf: (navn: string, tid: string) => `Afgjort af ${navn} ${tid}`,
  svar: "Svar til klageren",
  abonnementNote:
    "Medhold åbner kontoen igen. Var kontoen lukket, blev firmaets abonnement opsagt ved lukningen. Tjek firmaet under Firmaer bagefter.",
} as const;
