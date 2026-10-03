// HOLD SYNKRON med public.auktion_kategorier() i databasen
// (supabase/migrations/20261004061000_auktionsregler_rettelser.sql), som
// afviser andre kategorier ved oprettelse og redigering.
export const kategorier = [
  "Elektronik",
  "Møbler",
  "Tøj & sko",
  "Biler",
  "Legetøj",
  "Sport",
  "Havemøbler",
  "Andet",
];
