// Kunst-kontrollen (20261023010000_kunst_forbudt.sql) kan blive deployet,
// før migrationen er kørt i produktion - rækkefølgen skal være ligegyldig.
// Koden, der læser/skriver auctions.kunst_* eller kalder kunst-RPC'erne,
// bruger denne til at genkende "kolonnen/funktionen findes ikke endnu" og
// falder så stille tilbage til det gamle (uden kunst-kontrol).
// Virker både på serveren og i browseren (ingen server-only).

// Filteret, der skjuler auktioner, som afventer kunst-kontrol.
export const IKKE_KUNST_AFVENTER = "kunst_kontrol.is.null,kunst_kontrol.neq.afventer";

export function manglerKunstSkema(fejl: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!fejl) return false;
  const kode = fejl.code ?? "";
  const besked = fejl.message ?? "";
  // 42703 = kolonne findes ikke, 42883 = funktion findes ikke (Postgres);
  // PGRST204/PGRST202 = PostgREST kender ikke kolonnen/funktionen.
  if (["42703", "42883", "PGRST204", "PGRST202"].includes(kode)) return /kunst/i.test(besked) || kode.startsWith("PGRST");
  return /kunst/i.test(besked) && /(does not exist|could not find|schema cache)/i.test(besked);
}
