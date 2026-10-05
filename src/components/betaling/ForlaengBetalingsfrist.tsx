"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import { forlaengBetalingsfrist } from "@/app/actions/betalingsfrist";
import { fristDato, fristValg } from "@/lib/betalingsfrist";

// Sælgerens knap på handelssiden, mens handlen afventer betaling.
export default function ForlaengBetalingsfrist({
  tradeId,
  betalSenest,
  maksBetalSenest,
}: {
  tradeId: string;
  betalSenest: string;
  maksBetalSenest: string;
}) {
  const router = useRouter();
  const valg = useMemo(() => fristValg(betalSenest, maksBetalSenest), [betalSenest, maksBetalSenest]);
  const [valgt, setValgt] = useState(valg[0]?.vaerdi ?? "");

  if (valg.length === 0) {
    return (
      <p className="mt-3 text-xs">
        Fristen er allerede forlænget så langt som muligt (højst 7 dage efter, at betalingsfristen startede).
      </p>
    );
  }

  return (
    <div className="mt-4">
      <BekraeftDialog
        triggerLabel="Forlæng betalingsfristen"
        triggerClassName="btn btn-sekundaer btn-lille"
        title="Forlæng betalingsfristen"
        description="Brug den, hvis I har aftalt det i chatten. Højst 7 dage efter, at betalingsfristen startede, og højst 3 gange. Køberen får besked om den nye frist."
        confirmLabel="Forlæng fristen"
        confirmDisabled={!valgt}
        onConfirm={async () => {
          const svar = await forlaengBetalingsfrist(tradeId, valgt);
          if ("fejl" in svar) return { fejl: svar.fejl };
        }}
        onSuccess={() => router.refresh()}
      >
        <label htmlFor="ny-betalingsfrist" className="block text-sm font-medium text-tekst">
          Ny frist
        </label>
        <select
          id="ny-betalingsfrist"
          value={valgt}
          onChange={(e) => setValgt(e.target.value)}
          className="mt-1 w-full rounded-lg border border-kant bg-white px-3 py-2 text-sm text-tekst"
        >
          {valg.map((v) => (
            <option key={v.vaerdi} value={v.vaerdi}>
              {v.label}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs text-tekst-svag">
          Nuværende frist: {fristDato(betalSenest)}.
        </p>
      </BekraeftDialog>
      <p className="mt-2 text-xs">
        Brug den, hvis I har aftalt det i chatten. Højst 7 dage efter, at betalingsfristen
        startede, og højst 3 gange.
      </p>
    </div>
  );
}
