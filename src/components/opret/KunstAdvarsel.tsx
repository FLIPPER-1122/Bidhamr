"use client";

import Link from "next/link";
import { Afkrydsning } from "@/components/opret/formular";
import { KUNST_TEKST } from "@/lib/kunstForbud";

// Advarsel i opret/ret auktion, når titel eller beskrivelse ligner kunst
// (src/lib/kunstForbud.ts). Sælgeren kan fortsætte med "Det er ikke kunst";
// databasen markerer auktionen og sender den til staff-tjek uanset hvad
// (20261023010000_kunst_forbudt.sql).
export default function KunstAdvarsel({
  id,
  ord,
  bekraeftet,
  onBekraeft,
  fejl,
}: {
  id: string;
  ord: string;
  bekraeftet: boolean;
  onBekraeft: (v: boolean) => void;
  fejl?: string | null;
}) {
  return (
    <div
      id={`${id}-boks`}
      tabIndex={-1}
      className="rounded-xl border border-advarsel-kant bg-advarsel-bg p-4 text-sm text-advarsel-tekst"
    >
      <p className="font-semibold">{KUNST_TEKST.advarselTitel}</p>
      <p className="mt-1">
        {KUNST_TEKST.advarsel(ord)}{" "}
        <Link href="/forbudte-varer#kunst-eller-plakat" target="_blank" className="font-medium underline">
          Kunst eller plakat?
        </Link>
      </p>
      <div className="mt-3 rounded-lg bg-white px-3 py-2">
        <Afkrydsning id={id} checked={bekraeftet} onChange={onBekraeft} fejl={fejl} hjaelp={KUNST_TEKST.bekraeftHjaelp}>
          {KUNST_TEKST.bekraeft}
        </Afkrydsning>
      </div>
    </div>
  );
}
