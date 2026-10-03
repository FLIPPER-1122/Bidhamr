"use client";

// Åbner browserens udskriftsdialog (gem som PDF eller udskriv).
export default function UdskrivKnap({ tekst = "Udskriv" }: { tekst?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg bg-orange-knap px-4 py-2 text-sm font-semibold text-white hover:bg-orange-knap-mork print:hidden"
    >
      {tekst}
    </button>
  );
}
