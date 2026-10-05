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

export { sendSenestTekst as afhentningsfristTekst } from "@/lib/afsendelsesfrist";
