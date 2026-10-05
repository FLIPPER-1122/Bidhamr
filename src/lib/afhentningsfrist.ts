// Afhentningsfrist (ROADMAP-BESLUTNINGER afsnit 2, "Afhentningsfrist", Filip
// 5. oktober 2026): køberen har 7 dage fra betalingen til at hente varen.
// Begge påmindes 2 døgn før fristen (dag 5). Sælgeren kan forlænge fristen
// højst 3 gange og højst til 14 dage efter betalingen. Er varen ikke hentet,
// og har staff ikke afgjort handlen 14 dage efter betalingen (og mindst 7 dage
// efter fristen), får køberen automatisk alle pengene tilbage.
//
// Ingen server-only-import: handelssiden og klienten bruger tallene til
// visning. Databasen håndhæver reglerne (afhentning_frist,
// afhentning_forlaeng_frist, afhentningsfrist_annuller i
// supabase/migrations/20261005080000_afhentningsfrist.sql).

export const AFHENTNINGSFRIST_DAGE = 7;
export const AFHENTNING_MAKS_DAGE = 14;
export const AFHENTNING_MAKS_FORLAENGELSER = 3;
// Påmindelsen sendes, når der er under 48 timer til fristen (dag 5).
export const AFHENTNING_PAAMIND_TIMER_FOER = 48;

// Den automatiske tilbagebetaling sker tidligst så mange dage efter fristen.
export const AFHENTNING_TILBAGEBETAL_DAGE_EFTER_FRIST = 7;

// Hvornår køberen automatisk får pengene tilbage, hvis varen ikke er hentet:
// greatest(betalt + 14 dage, frist + 7 dage). maksFrist er betalt + 14 dage
// (afhentning_info.maks_frist). Skal holdes ens med SQL-funktionen
// public.afhentning_tilbagebetal_kl i
// supabase/migrations/20261005080000_afhentningsfrist.sql. Kun til visning -
// databasen afgør, hvornår pengene sendes tilbage.
export function afhentningTilbagebetalKl(frist: string, maksFrist: string): string {
  const fraFrist = new Date(frist).getTime() + AFHENTNING_TILBAGEBETAL_DAGE_EFTER_FRIST * 24 * 60 * 60 * 1000;
  return new Date(Math.max(new Date(maksFrist).getTime(), fraFrist)).toISOString();
}

export { sendSenestTekst as afhentningsfristTekst } from "@/lib/afsendelsesfrist";
