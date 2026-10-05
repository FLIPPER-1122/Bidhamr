"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import { forlaengAfhentningsfrist } from "@/app/actions/afhentning";
import { fristDato, fristValg } from "@/lib/betalingsfrist";

// Sælgerens knap på handelssiden, mens køberen endnu ikke har hentet varen.
// Samme mønster som ForlaengBetalingsfrist. Reglerne håndhæves i databasen
// (afhentning_forlaeng_frist).
export default function ForlaengAfhentningsfrist({
  tradeId,
  frist,
  maksFrist,
}: {
  tradeId: string;
  frist: string;
  maksFrist: string;
}) {
  const router = useRouter();
  const valg = useMemo(() => fristValg(frist, maksFrist), [frist, maksFrist]);
  const [valgt, setValgt] = useState(valg[0]?.vaerdi ?? "");

  if (valg.length === 0) return null;

  return (
    <div className="mt-4">
      <BekraeftDialog
        triggerLabel="Forlæng fristen for afhentning"
        triggerClassName="btn btn-sekundaer btn-lille"
        title="Forlæng fristen for afhentning"
        description="Brug den, hvis I har aftalt en senere dag i chatten. Højst 14 dage efter betalingen, og højst 3 gange. Køberen får besked om den nye frist."
        confirmLabel="Forlæng fristen"
        confirmDisabled={!valgt}
        onConfirm={async () => {
          const svar = await forlaengAfhentningsfrist(tradeId, valgt);
          if ("fejl" in svar) return { fejl: svar.fejl };
        }}
        onSuccess={() => router.refresh()}
      >
        <label htmlFor="ny-afhentningsfrist" className="block text-sm font-medium text-tekst">
          Ny frist
        </label>
        <select
          id="ny-afhentningsfrist"
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
        <p className="mt-2 text-xs text-tekst-svag">Nuværende frist: {fristDato(frist)}.</p>
      </BekraeftDialog>
      <p className="mt-2 text-xs text-neutral-500">
        Har I aftalt en senere dag i chatten, kan du give køberen mere tid. Højst 14 dage efter
        betalingen, og højst 3 gange.
      </p>
    </div>
  );
}
