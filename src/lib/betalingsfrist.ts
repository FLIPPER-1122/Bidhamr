// Betalingsfristen (ROADMAP-BESLUTNINGER.md, "Betalingsfrist", 5. oktober 2026).
// Vinderen har 48 timer. Sælgeren kan forlænge fristen til højst 7 dage efter,
// at fristen startede (auktionens afslutning, eller når næste byder sagde ja).
// Databasen (handel_forlaeng_betalingsfrist) håndhæver reglerne - dette er kun
// til visning og forslag. Ingen server-only: bruges også i klienten.

export const BETALINGSFRIST_TIMER = 48;
export const MAKS_FORLAENGELSE_DAGE = 7;

const DAG_MS = 24 * 60 * 60 * 1000;

// Seneste tilladte frist, afrundet ned til hele sekunder som i databasen.
export function maksBetalingsfrist(betalingOprettet: string): string {
  const ms = new Date(betalingOprettet).getTime() + MAKS_FORLAENGELSE_DAGE * DAG_MS;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

export type FristValg = { vaerdi: string; label: string };

// Forslag til en ny frist: +1, +2, ... dage fra den nuværende frist, så
// længe de ligger inden for grænsen, og til sidst den sidste mulige frist.
export function fristValg(nuvaerende: string, maks: string): FristValg[] {
  const fra = new Date(nuvaerende).getTime();
  const til = new Date(maks).getTime();
  const valg: FristValg[] = [];
  for (let dage = 1; dage <= MAKS_FORLAENGELSE_DAGE; dage++) {
    const ms = fra + dage * DAG_MS;
    if (ms > til) break;
    valg.push({
      vaerdi: new Date(ms).toISOString(),
      label: `${dage === 1 ? "1 dag" : `${dage} dage`} mere (${fristDato(new Date(ms).toISOString())})`,
    });
  }
  if (til > fra && (valg.length === 0 || new Date(valg[valg.length - 1].vaerdi).getTime() < til)) {
    valg.push({ vaerdi: new Date(til).toISOString(), label: `Sidste mulige frist (${fristDato(maks)})` });
  }
  return valg;
}

export function fristDato(iso: string): string {
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
