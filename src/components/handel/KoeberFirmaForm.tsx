"use client";

// Køberen oplyser selv firmanavn og CVR til sælgers faktura (før den sendes).
import { useState, useTransition } from "react";
import { gemKoeberFakturaFirma } from "@/app/actions/firmaFaktura";

export default function KoeberFirmaForm({ tradeId, firmanavn, cvr }: { tradeId: string; firmanavn: string | null; cvr: string | null }) {
  const [navn, setNavn] = useState(firmanavn ?? "");
  const [nr, setNr] = useState(cvr ?? "");
  const [besked, setBesked] = useState<{ ok: boolean; tekst: string } | null>(null);
  const [travl, start] = useTransition();

  return (
    <details className="mt-4" open={!!firmanavn}>
      <summary className="cursor-pointer text-[15px] font-semibold text-groen">Køber du som firma? Få firmanavn og CVR på fakturaen</summary>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-[1fr_160px_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const s = await gemKoeberFakturaFirma(tradeId, navn, nr);
            setBesked("fejl" in s ? { ok: false, tekst: s.fejl } : { ok: true, tekst: "Gemt. Sælgeren bruger det på fakturaen." });
          });
        }}
      >
        <div>
          <label htmlFor={`kf-navn-${tradeId}`} className="mb-1 block text-sm font-semibold">
            Firmanavn
          </label>
          <input id={`kf-navn-${tradeId}`} value={navn} onChange={(e) => setNavn(e.target.value)} maxLength={200} autoComplete="organization" className="min-h-11 w-full border border-kant px-3" />
        </div>
        <div>
          <label htmlFor={`kf-cvr-${tradeId}`} className="mb-1 block text-sm font-semibold">
            CVR
          </label>
          <input id={`kf-cvr-${tradeId}`} value={nr} onChange={(e) => setNr(e.target.value)} inputMode="numeric" maxLength={11} className="min-h-11 w-full border border-kant px-3" />
        </div>
        <button type="submit" disabled={travl} className="btn-sekundaer min-h-11 border-2 px-4 font-semibold">
          {travl ? "Gemmer …" : "Gem"}
        </button>
      </form>
      {besked && (
        <p role={besked.ok ? "status" : "alert"} className={`mt-2 text-sm ${besked.ok ? "text-succes-tekst" : "text-fejl-tekst"}`}>
          {besked.tekst}
        </p>
      )}
    </details>
  );
}
