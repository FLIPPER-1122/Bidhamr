"use client";

// Åbner browserens udskriftsdialog (gem som PDF eller udskriv).
export default function UdskrivKnap({ tekst = "Udskriv" }: { tekst?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="btn btn-primaer print:hidden"
    >
      {tekst}
    </button>
  );
}
