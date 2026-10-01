"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  opdaterSaelgerStatus,
  startSaelgerOnboarding,
  type Betalingsindstillinger,
} from "@/app/actions/betaling";
import { FejlBoks } from "@/components/betaling/BetalingSektion";

export default function KontoUdbetaling({
  saelger,
  erRetur,
}: {
  saelger: Betalingsindstillinger["saelger"];
  erRetur: boolean;
}) {
  const router = useRouter();
  const [fejl, setFejl] = useState<string | null>(null);
  const [venter, startTransition] = useTransition();
  const opdateret = useRef(false);

  // Tilbage fra Stripes onboarding (?stripe=retur): hent status fra Stripe.
  useEffect(() => {
    if (!erRetur || opdateret.current) return;
    opdateret.current = true;
    opdaterSaelgerStatus().then((svar) => {
      if ("fejl" in svar) setFejl(svar.fejl);
      router.replace("/konto");
      router.refresh();
    });
  }, [erRetur, router]);

  function start() {
    setFejl(null);
    startTransition(async () => {
      const svar = await startSaelgerOnboarding();
      if ("fejl" in svar) setFejl(svar.fejl);
      else window.location.href = svar.url;
    });
  }

  const klar = saelger.overfoerslerAktiv && saelger.udbetalingerAktiv;

  let status: { tekst: string; stil: string };
  if (klar) {
    status = { tekst: "Klar til udbetaling", stil: "border-[#B9D8CC] bg-groen-lys text-groen-mork" };
  } else if (saelger.detaljerIndsendt) {
    status = { tekst: "Stripe tjekker dine oplysninger", stil: "border-[#C9DCEB] bg-[#EDF3F8] text-[#1F4E79]" };
  } else if (saelger.harKonto) {
    status = { tekst: "Mangler oplysninger", stil: "border-[#F5D9B0] bg-[#FEF3E2] text-[#8A4210]" };
  } else {
    status = { tekst: "Ikke oprettet", stil: "border-kant bg-white text-tekst-daempet" };
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-tekst-daempet">
        Når du sælger, udbetaler Stripe pengene til din bankkonto. Opret din
        udbetalingskonto, før du sælger.
      </p>
      {fejl && <FejlBoks tekst={fejl} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={`rounded-full border px-3 py-1 text-sm font-medium ${status.stil}`}>
          {status.tekst}
        </span>
        {!klar && (
          <button type="button" onClick={start} disabled={venter} className="btn btn-primaer w-full sm:w-auto">
            {venter
              ? "Sender dig videre…"
              : saelger.harKonto
                ? "Fortsæt opsætning hos Stripe"
                : "Opret udbetalingskonto"}
          </button>
        )}
      </div>
    </div>
  );
}
