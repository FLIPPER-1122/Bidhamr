// Ikoner i Tabler-stil (DESIGN.md afsnit 10): 24x24, streg 1.75, runde ender.
// Stierne er gengivet som inline-SVG, så der ikke hentes en ikon-webfont, og
// kun de ikoner, der bruges, kommer med. Virker i både server- og klientkomponenter.

const STIER = {
  soeg: ["M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0", "M21 21l-6 -6"],
  skjold: [
    "M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3",
    "M9 12l2 2l4 -4",
  ],
  kort: [
    "M3 8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z",
    "M3 10h18",
    "M7 15h.01",
    "M11 15h2",
  ],
  pakkeTjek: [
    "M12 21l-8 -4.5v-9l8 -4.5l8 4.5v4.5",
    "M12 12l8 -4.5",
    "M12 12v9",
    "M12 12l-8 -4.5",
    "M15 19l2 2l4 -4",
  ],
  hjaelp: [
    "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
    "M12 17v.01",
    "M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4",
  ],
  ur: ["M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M12 7v5l3 3"],
  hjerte: ["M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"],
  besked: [
    "M8 9h8",
    "M8 13h6",
    "M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z",
  ],
  handler: [
    "M6.331 8h11.339a2 2 0 0 1 1.977 2.304l-1.255 8.152a3 3 0 0 1 -2.966 2.544h-6.852a3 3 0 0 1 -2.965 -2.544l-1.255 -8.152a2 2 0 0 1 1.977 -2.304z",
    "M9 11v-5a3 3 0 0 1 6 0v5",
  ],
  bruger: ["M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0", "M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"],
  menu: ["M4 6h16", "M4 12h16", "M4 18h16"],
  luk: ["M18 6l-12 12", "M6 6l12 12"],
  ned: ["M6 9l6 6l6 -6"],
  hoejre: ["M5 12h14", "M13 18l6 -6", "M13 6l6 6"],
  plus: ["M12 5v14", "M5 12h14"],
  indstillinger: [
    "M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z",
    "M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0",
  ],
  klokke: [
    "M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6",
    "M9 17v1a3 3 0 0 0 6 0v-1",
  ],
  skjoldLaas: [
    "M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3",
    "M11 11a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M12 12v2.5",
  ],
  venstre: ["M5 12h14", "M5 12l6 6", "M5 12l6 -6"],
  filter: ["M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227z"],
  kategorier: [
    "M4 4h6v6h-6z",
    "M14 4h6v6h-6z",
    "M4 14h6v6h-6z",
    "M14 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
  ],
  // Kategorier
  elektronik: [
    "M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10z",
    "M7 20h10",
    "M9 16v4",
    "M15 16v4",
  ],
  moebler: [
    "M4 11a2 2 0 0 1 2 2v1h12v-1a2 2 0 1 1 4 0v5a1 1 0 0 1 -1 1h-18a1 1 0 0 1 -1 -1v-5a2 2 0 0 1 2 -2z",
    "M4 11v-3a3 3 0 0 1 3 -3h10a3 3 0 0 1 3 3v3",
    "M12 5v9",
  ],
  toej: ["M15 4l6 2v5h-3v8a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1v-8h-3v-5l6 -2a3 3 0 0 0 6 0"],
  bil: [
    "M5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M15 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M5 17h-2v-6l2 -5h9l4 5h1a2 2 0 0 1 2 2v4h-2m-4 0h-6m-6 -6h15m-6 0v-5",
  ],
  legetoej: [
    "M3 16.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
    "M16 16.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0",
    "M8 16.5h8",
    "M4 14v-5h9v5",
    "M13 9l2.5 -3h2.5l2 8",
    "M7 9v-3h3v3",
  ],
  sport: [
    "M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
    "M12 7l4.76 3.45l-1.76 5.55h-6l-1.76 -5.55z",
    "M12 7v-4m3 13l2.5 3m-.74 -8.55l3.74 -1.45m-11.44 7.05l-2.56 2.95m.74 -8.55l-3.74 -1.45",
  ],
  have: [
    "M12 3l-6 6h4v4h4v-4h4z",
    "M12 13v8",
    "M5 21h14",
    "M7 17h10",
  ],
  andet: [
    "M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
    "M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  ],
} as const;

export type IkonNavn = keyof typeof STIER;

export default function Ikon({
  navn,
  className = "h-5 w-5",
  strøg = 1.75,
}: {
  navn: IkonNavn;
  className?: string;
  strøg?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strøg}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {STIER[navn].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

// Ikon pr. kategori i src/lib/kategorier.ts
export const KATEGORI_IKON: Record<string, IkonNavn> = {
  Elektronik: "elektronik",
  Møbler: "moebler",
  "Tøj & sko": "toej",
  Biler: "bil",
  Legetøj: "legetoej",
  Sport: "sport",
  Havemøbler: "have",
  Andet: "andet",
};
