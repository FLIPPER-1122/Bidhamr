"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  bekraeftGemtKort,
  fjernGemtKort,
  saetAutobetaling,
  startGemKort,
  type Betalingsindstillinger,
} from "@/app/actions/betaling";
import { FejlBoks } from "@/components/betaling/FejlBoks";
import { AUTOBETALING_SAMTYKKE } from "@/lib/betaling/samtykke";

// Stripe.js og Payment Element indlæses først, når brugeren har trykket
// "Gem et kort" – ikke ved hvert besøg på Min konto.
const GemKortStripe = dynamic(() => import("@/components/betaling/GemKortStripe"), {
  ssr: false,
  loading: () => (
    <div className="space-y-3 rounded-xl border border-kant p-4" aria-busy="true" aria-label="Henter kortformular">
      <div className="h-11 animate-pulse rounded-xl bg-skelet" />
      <div className="h-11 animate-pulse rounded-xl bg-skelet" />
    </div>
  ),
});

const MAERKE: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  dankort: "Dankort",
};

export default function KontoBetaling({
  gemtKort,
  autobetaling,
  setupIntentId,
}: {
  gemtKort: Betalingsindstillinger["gemtKort"];
  autobetaling: boolean;
  setupIntentId: string | null;
}) {
  const router = useRouter();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [besked, setBesked] = useState<string | null>(null);
  const [venter, startTransition] = useTransition();
  const bekraeftet = useRef(false);

  // Tilbage fra Stripe efter "gem kort": registrér kortet, og ryd URL'en.
  useEffect(() => {
    if (!setupIntentId || bekraeftet.current) return;
    bekraeftet.current = true;
    bekraeftGemtKort(setupIntentId).then((svar) => {
      if ("fejl" in svar) setFejl(svar.fejl);
      else setBesked("Dit kort er gemt.");
      router.replace("/konto");
      router.refresh();
    });
  }, [setupIntentId, router]);

  function gemKort() {
    setFejl(null);
    setBesked(null);
    startTransition(async () => {
      const svar = await startGemKort();
      if ("fejl" in svar) setFejl(svar.fejl);
      else setClientSecret(svar.clientSecret);
    });
  }

  function fjern() {
    if (!confirm("Vil du fjerne dit gemte kort? Automatisk betaling slås fra.")) return;
    setFejl(null);
    startTransition(async () => {
      const svar = await fjernGemtKort();
      if ("fejl" in svar) setFejl(svar.fejl);
      else {
        setBesked("Kortet er fjernet.");
        router.refresh();
      }
    });
  }

  function skiftAuto(til: boolean) {
    setFejl(null);
    startTransition(async () => {
      const svar = await saetAutobetaling(til);
      if ("fejl" in svar) setFejl(svar.fejl);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-tekst-daempet">
        Du kan byde uden at gemme et kort. Vinder du, betaler du inden for 48 timer.
      </p>

      {besked && (
        <p className="rounded-xl border border-succes-kant bg-groen-lys px-4 py-3 text-sm text-groen-mork">
          {besked}
        </p>
      )}
      {fejl && <FejlBoks tekst={fejl} />}

      {gemtKort ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-kant p-4">
          <div>
            <p className="font-semibold text-tekst">
              {MAERKE[gemtKort.maerke ?? ""] ?? "Kort"} •••• {gemtKort.sidste4 ?? "????"}
            </p>
            {gemtKort.udloeb && (
              <p className="text-sm text-tekst-svag">Udløber {gemtKort.udloeb}</p>
            )}
          </div>
          <button type="button" onClick={fjern} disabled={venter} className="btn btn-sekundaer btn-lille">
            Fjern kort
          </button>
        </div>
      ) : clientSecret ? (
        <GemKortStripe clientSecret={clientSecret} onAnnuller={() => setClientSecret(null)} />
      ) : (
        <button type="button" onClick={gemKort} disabled={venter} className="btn btn-primaer w-full sm:w-auto">
          {venter ? "Henter…" : "Gem et kort"}
        </button>
      )}

      <label
        className={`flex gap-3 rounded-xl border border-kant p-4 ${
          gemtKort ? "cursor-pointer bg-groen-lys" : "cursor-not-allowed opacity-60"
        }`}
      >
        <input
          type="checkbox"
          checked={autobetaling && !!gemtKort}
          disabled={!gemtKort || venter}
          onChange={(e) => skiftAuto(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-groen"
        />
        <span className="text-sm">
          <span className="font-semibold text-groen-mork">{AUTOBETALING_SAMTYKKE.overskrift}</span>
          <span className="mt-1 block text-tekst-daempet">
            {gemtKort
              ? AUTOBETALING_SAMTYKKE.tekst
              : "Gem et kort for at kunne slå automatisk betaling til. Det er et tilvalg."}
          </span>
        </span>
      </label>
    </div>
  );
}
