// Ikoner til valgene i trin 1 (Tabler-stil som src/components/Ikon.tsx).
// Samme ikoner som showcase/opret-sag-showcase.html.
import type { SagValgId } from "@/lib/tekster/sagValg";

const STIER: Record<SagValgId, string[]> = {
  stykker: ["M4 4h16v16h-16z", "M12 4l-2 5l4 3l-3 4l1 4"],
  annonce: [
    "M14 3v4a1 1 0 0 0 1 1h4",
    "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z",
    "M9 13l6 0",
    "M9 17l6 0",
  ],
  anden_vare: ["M7 10h14l-4 -4", "M17 14h-14l4 4"],
  tom: ["M12 21l-8 -4v-7l8 4l8 -4v7z", "M4 10l-2 -3l8 -3l2 3", "M20 10l2 -3l-8 -3l-2 3"],
  ikke_kommet: [
    "M5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M15 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M5 17h-2v-11a1 1 0 0 1 1 -1h9v12m-4 0h6m4 0h2v-6h-8m0 -5h5l3 5",
  ],
  andet: [
    "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
    "M12 17l0 .01",
    "M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4",
  ],
};

export default function ValgIkon({ valg, className = "h-6 w-6" }: { valg: SagValgId; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {STIER[valg].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
