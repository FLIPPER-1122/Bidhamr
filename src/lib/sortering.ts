// Sorteringer på /auktioner. Ligger uden for klientkomponenten, så
// server-siden kan læse ?sortering= (forsiden og menuen linker dertil).
export type Sortering = "slutter_snart" | "laveste_bud" | "højeste_bud" | "nyeste";

export const SORTERINGER: { værdi: Sortering; tekst: string }[] = [
  { værdi: "slutter_snart", tekst: "Slutter snart" },
  { værdi: "nyeste", tekst: "Nyeste" },
  { værdi: "laveste_bud", tekst: "Laveste bud" },
  { værdi: "højeste_bud", tekst: "Højeste bud" },
];

export function læsSortering(værdi: string | undefined): Sortering {
  return SORTERINGER.find((s) => s.værdi === værdi)?.værdi ?? "slutter_snart";
}
