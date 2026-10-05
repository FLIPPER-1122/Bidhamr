"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { opdaterSaelgerStatus, startSaelgerOnboarding } from "@/app/actions/betaling";
import { FejlBoks } from "@/components/betaling/BetalingSektion";

// Vises på /opret-auktion i stedet for formularen, når sælgeren ikke har en
// udbetalingskonto (eller ikke har sendt oplysningerne ind hos Stripe).
// Tilbage fra Stripe (?stripe=retur) hentes status, og siden genindlæses –
// er oplysningerne sendt ind, vises formularen.
export default function UdbetalingskontoKraeves({
  harKonto,
  erRetur,
  erFejl,
}: {
  harKonto: boolean;
  erRetur: boolean;
  erFejl: boolean;
}) {
  const router = useRouter();
  const [fejl, setFejl] = useState<string | null>(
    erFejl ? "Vi kunne ikke åbne Stripe. Prøv igen om lidt." : null,
  );
  const [venter, startTransition] = useTransition();
  const [henter, setHenter] = useState(erRetur);
  const opdateret = useRef(false);

  useEffect(() => {
    if (!erRetur || opdateret.current) return;
    opdateret.current = true;
    opdaterSaelgerStatus().then((svar) => {
      if ("fejl" in svar) setFejl(svar.fejl);
      setHenter(false);
      router.replace("/opret-auktion");
      router.refresh();
    });
  }, [erRetur, router]);

  function start() {
    setFejl(null);
    startTransition(async () => {
      const svar = await startSaelgerOnboarding("opret-auktion");
      if ("fejl" in svar) setFejl(svar.fejl);
      else window.location.href = svar.url;
    });
  }

  if (henter) {
    return (
      <p className="rounded-lg border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
        Henter status fra Stripe…
      </p>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-advarsel-kant bg-advarsel-bg p-5">
      <p className="text-sm text-advarsel-tekst">
        For at sælge skal du have en udbetalingskonto, så Stripe kan sende pengene til din bank.
      </p>
      {fejl && <FejlBoks tekst={fejl} />}
      <button type="button" onClick={start} disabled={venter} className="btn btn-primaer w-full">
        {venter
          ? "Sender dig videre…"
          : harKonto
            ? "Gør udbetalingskontoen færdig"
            : "Opret udbetalingskonto"}
      </button>
    </div>
  );
}
