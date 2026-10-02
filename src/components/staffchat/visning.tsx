// Fælles visning til chat med BidHamr (bruger- og admin-side) og
// fællesbeskeder i handelschatten. Ingen "use client": bruges begge steder.

// Fast tidszone, så server og browser viser det samme (ingen hydreringsfejl).
export function beskedTid(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

export function dato(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Copenhagen",
  });
}

export function forkort(tekst: string, n = 90): string {
  const enLinje = tekst.replace(/\s+/g, " ").trim();
  return enLinje.length > n ? `${enLinje.slice(0, n - 1)}…` : enLinje;
}

// Lille mærke, der viser at en besked kommer fra BidHamr. Farve bærer ikke
// betydningen alene: der står "BidHamr" og et skjold-ikon.
export function BidhamrMaerke({ lille = false }: { lille?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-groen font-semibold text-white ${
        lille ? "px-2 py-0.5 text-[12px]" : "px-2.5 py-1 text-[13px]"
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        className={lille ? "h-3 w-3" : "h-3.5 w-3.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
      </svg>
      BidHamr
    </span>
  );
}

export function AfsluttetMaerke() {
  return (
    <span className="inline-flex items-center rounded-full border border-kant-staerk bg-white px-2 py-0.5 text-[12px] font-semibold text-tekst-daempet">
      Afsluttet
    </span>
  );
}

export const LUKKET_TEKST =
  "Chatten er afsluttet af BidHamr. Har du brug for hjælp, så skriv til support@bidhamr.dk.";
