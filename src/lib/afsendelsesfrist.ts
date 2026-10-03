// Afsendelsesfrist (ROADMAP-BESLUTNINGER, "Midlertidige beslutninger"):
// sælgeren skal markere pakken sendt inden 5 dage efter betalingen
// (betalinger.betalt_kl). Ellers annulleres handlen automatisk, og køberen
// refunderes fuldt. Kun handler med forsendelse - ikke afhentning.
//
// Ingen server-only-import: handelssiden bruger fristen til visning.
// Tallet er spejlet i SQL (afsendelsesfrist_annuller i
// supabase/migrations/20261004020000_afsendelsesfrist.sql).

export const AFSENDELSESFRIST_DAGE = 5;
// Påmindelser til sælgeren efter dag 3 og dag 4.
export const AFSENDELSE_PAAMIND_DAGE = [3, 4] as const;

const DAG_MS = 24 * 60 * 60 * 1000;

// Tidspunktet, hvor pakken senest skal være markeret sendt (ISO), eller null.
export function sendSenest(betaltKl: string | null | undefined): string | null {
  if (!betaltKl) return null;
  const ms = Date.parse(betaltKl);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + AFSENDELSESFRIST_DAGE * DAG_MS).toISOString();
}

// Fx "mandag 6. oktober kl. 14.30" (dansk tid).
export function sendSenestTekst(iso: string): string {
  const d = new Date(iso);
  const dag = d.toLocaleDateString("da-DK", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Copenhagen",
  });
  const tid = d.toLocaleTimeString("da-DK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
  return `${dag} kl. ${tid}`;
}
