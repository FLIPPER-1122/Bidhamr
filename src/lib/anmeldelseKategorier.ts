// Nøglerne skal matche check-constrainten på reports.category i
// supabase/migrations/20260825020000_reports.sql
export const ANMELDELSE_KATEGORIER = [
  { vaerdi: "ulovlig_vare", label: "Ulovlig vare" },
  { vaerdi: "forfalsket_vare", label: "Falsk/forfalsket vare" },
  { vaerdi: "spam_duplikat", label: "Spam eller duplikat" },
  { vaerdi: "stoedende_indhold", label: "Stødende indhold" },
  { vaerdi: "mistaenkelig_saelger", label: "Mistænkelig sælger" },
  { vaerdi: "andet", label: "Andet" },
] as const;

export type AnmeldelseKategori = (typeof ANMELDELSE_KATEGORIER)[number]["vaerdi"];

export function kategoriLabel(vaerdi: string) {
  return ANMELDELSE_KATEGORIER.find((k) => k.vaerdi === vaerdi)?.label ?? vaerdi;
}
