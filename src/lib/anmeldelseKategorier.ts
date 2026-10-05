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

// Kategorier, som kun systemet bruger (brugere kan ikke vælge dem).
// 'forbudt_vare': automatisk rapport fra kontrollen af forbudte ord
// (20261006040000_auktionsfunktioner.sql, auctions_forbudt_rapport).
const SYSTEM_KATEGORIER: Record<string, string> = {
  forbudt_vare: "Mulig forbudt vare (automatisk)",
};

export function kategoriLabel(vaerdi: string) {
  return (
    ANMELDELSE_KATEGORIER.find((k) => k.vaerdi === vaerdi)?.label ?? SYSTEM_KATEGORIER[vaerdi] ?? vaerdi
  );
}
