// Små hjælpere til visning af notifikationer (klokke-panel og indbakke).
// Ingen server-only-import: bruges i klient-komponenter.

const MINUT = 60_000;
const TIME = 60 * MINUT;
const DAG = 24 * TIME;

// "lige nu", "for 5 min. siden", "for 2 timer siden", "i går", "for 3 dage siden",
// derefter en dato ("12. sep." / "12. sep. 2025").
export function relativTid(iso: string, nu: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Math.max(0, nu - t);

  if (diff < MINUT) return "lige nu";
  if (diff < TIME) return `for ${Math.floor(diff / MINUT)} min. siden`;
  if (diff < DAG) {
    const timer = Math.floor(diff / TIME);
    return timer === 1 ? "for 1 time siden" : `for ${timer} timer siden`;
  }
  const dage = Math.floor(diff / DAG);
  if (dage === 1) return "i går";
  if (dage < 7) return `for ${dage} dage siden`;

  const dato = new Date(t);
  const sammeAar = dato.getFullYear() === new Date(nu).getFullYear();
  return dato.toLocaleDateString("da-DK", {
    day: "numeric",
    month: "short",
    ...(sammeAar ? {} : { year: "numeric" }),
    timeZone: "Europe/Copenhagen",
  });
}

// Fuld dato og tid til title/datetime-tooltip.
export function fuldTid(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString("da-DK", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Copenhagen",
  });
}

// Kun interne stier må bruges som link (beskytter mod åbne omdirigeringer,
// hvis der nogensinde kommer et ondsindet link ind i en notifikation).
export function sikkertLink(link: string | null | undefined): string | null {
  if (!link || typeof link !== "string") return null;
  if (!link.startsWith("/") || link.startsWith("//") || link.startsWith("/\\")) return null;
  return link;
}

export function badgeTekst(antal: number): string {
  return antal > 9 ? "9+" : String(antal);
}

// Sendes, når noget er markeret som læst, så klokken kan hente sit tal igen.
export const NOTIFIKATIONER_OPDATERET = "bidhamr:notifikationer-opdateret";

export function meldNotifikationerOpdateret() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(NOTIFIKATIONER_OPDATERET));
  }
}

// Antal pr. side i indbakken (/notifikationer).
export const SIDE_STOERRELSE = 20;
