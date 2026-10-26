// Fælles stil og formatering til firmasiden i admin (både server- og
// klientkomponenter - derfor ikke i en "use client"-fil).

// Kortet i hurtighandlingerne (trigger til en dialog).
export const KORT =
  "flex min-h-[64px] w-full flex-col items-start justify-center gap-0.5 border border-kant bg-white px-4 py-3 text-left text-xs font-normal text-tekst-daempet transition-colors hover:border-groen focus-visible:outline-2 focus-visible:outline-groen";

// Samme kort, når handlingen ikke kan bruges lige nu (vises med forklaring).
export const KORT_LAAST =
  "flex min-h-[64px] w-full flex-col items-start justify-center gap-0.5 border border-kant bg-admin-graa px-4 py-3 text-left text-xs text-tekst-daempet";

// ISO-ugenummer for en dato (ÅÅÅÅ-MM-DD).
export function ugeNr(iso: string): number {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const aarStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - aarStart) / 86400000 + 1) / 7);
}

// "2026-11-09" (en mandag) -> "9. nov."
export function mandag(uge: string): string {
  return new Date(`${uge}T12:00:00Z`).toLocaleDateString("da-DK", { day: "numeric", month: "short", timeZone: "Europe/Copenhagen" });
}
