"use client";

import { useState, useTransition } from "react";
import { startSaelgerOnboarding } from "@/app/actions/betaling";
import { FejlBoks } from "@/components/betaling/FejlBoks";
import { FIRMA_UDBETALINGSKONTO as U } from "@/lib/tekster/erhverv";
import { E_KNAP_PRIMAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";

// "Venter på dig" på Overblik (/firma): firmaet har ingen færdig
// udbetalingskonto. Knappen starter samme flow som "Hvor skal pengene sendes
// hen?" på Opret auktion (UdbetalingskontoKraeves) - Stripe sender firmaet
// tilbage til /opret-auktion?stripe=retur (gaten -> /firma/auktioner/ny).
export default function BankkontoOpgave({ harKonto }: { harKonto: boolean }) {
  const [fejl, setFejl] = useState<string | null>(null);
  const [venter, startTransition] = useTransition();

  function start() {
    setFejl(null);
    startTransition(async () => {
      const svar = await startSaelgerOnboarding("opret-auktion");
      if ("fejl" in svar) setFejl(svar.fejl);
      else window.location.href = svar.url;
    });
  }

  return (
    <div className="rounded-none border-2 border-orange bg-orange-lys p-4">
      <p className={`${E_TEKST} font-semibold`}>{harKonto ? U.opgaveFaerdig : U.opgave}</p>
      <p className={`mt-1 ${E_TEKST_DAEMPET}`}>{U.opgaveTid}</p>
      {fejl && (
        <div className="mt-3">
          <FejlBoks tekst={fejl} />
        </div>
      )}
      <button
        type="button"
        onClick={start}
        disabled={venter}
        aria-busy={venter || undefined}
        className={`${E_KNAP_PRIMAER} mt-3 w-full sm:w-auto`}
      >
        {venter ? U.knapSender : harKonto ? U.knapFaerdig : U.knapOpret}
      </button>
    </div>
  );
}
