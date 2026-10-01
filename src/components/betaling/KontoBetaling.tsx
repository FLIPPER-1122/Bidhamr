"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import {
  bekraeftGemtKort,
  fjernGemtKort,
  saetAutobetaling,
  startGemKort,
  type Betalingsindstillinger,
} from "@/app/actions/betaling";
import { hentStripe, stripeUdseende } from "@/lib/stripeKlient";
import { FejlBoks } from "@/components/betaling/BetalingSektion";

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
        <p className="rounded-xl border border-[#B9D8CC] bg-groen-lys px-4 py-3 text-sm text-groen-mork">
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
        <Elements
          stripe={hentStripe()}
          options={{ clientSecret, appearance: stripeUdseende, locale: "da" }}
        >
          <GemKortForm onAnnuller={() => setClientSecret(null)} />
        </Elements>
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
          className="mt-0.5 h-5 w-5 shrink-0 accent-[#1E5E4A]"
        />
        <span className="text-sm">
          <span className="font-semibold text-groen-mork">Betal automatisk, når jeg vinder</span>
          <span className="mt-1 block text-tekst-daempet">
            {gemtKort
              ? "Tilvalg: Vinder du, trækkes totalprisen på dit gemte kort. Du kan slå det fra når som helst."
              : "Gem et kort for at kunne slå automatisk betaling til. Det er et tilvalg."}
          </span>
        </span>
      </label>
    </div>
  );
}

function GemKortForm({ onAnnuller }: { onAnnuller: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  async function gem(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSender(true);
    setFejl(null);
    const { error } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: `${window.location.origin}/konto` },
    });
    setFejl(error?.message ?? "Kortet kunne ikke gemmes. Prøv igen.");
    setSender(false);
  }

  return (
    <form onSubmit={gem} className="space-y-4 rounded-xl border border-kant p-4">
      <PaymentElement options={{ layout: "tabs" }} />
      {fejl && <FejlBoks tekst={fejl} />}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="submit" disabled={!stripe || sender} className="btn btn-primaer">
          {sender ? "Gemmer…" : "Gem kort"}
        </button>
        <button type="button" onClick={onAnnuller} disabled={sender} className="btn btn-sekundaer">
          Annullér
        </button>
      </div>
    </form>
  );
}
