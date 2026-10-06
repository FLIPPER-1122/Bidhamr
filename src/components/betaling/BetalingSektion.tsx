"use client";

import { useState, type FormEvent } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { FejlBoks } from "@/components/betaling/FejlBoks";
import { startBetaling, type KoeberBetalingsstatus } from "@/app/actions/betaling";
import { hentStripe, stripeUdseende } from "@/lib/stripeKlient";
import { kroner } from "@/lib/kroner";
import { BETINGELSER_STI } from "@/lib/vilkaar";

// Køberens betaling af en vundet auktion. Alle beløb kommer fra serveren -
// klienten lægger aldrig noget sammen.
// BidHamr Beskyttelse er valgt (eller fravalgt) ved buddet og kan ikke ændres
// her - den vises kun som en linje i opdelingen.
export default function BetalingSektion({ status }: { status: KoeberBetalingsstatus }) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [totalOere, setTotalOere] = useState(status.totalOere);
  const [henter, setHenter] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  async function hent() {
    setHenter(true);
    setFejl(null);
    const svar = await startBetaling(status.handelId);
    setHenter(false);
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      return;
    }
    setClientSecret(svar.clientSecret);
    setTotalOere(svar.totalOere);
  }

  return (
    <div className="space-y-5">
      <dl className="space-y-2 text-sm">
        <Linje navn="Dit bud" vaerdi={kroner(status.budOere)} />
        <Linje navn="Købergebyr" vaerdi={kroner(status.koebergebyrOere)} />
        {status.fragtOere > 0 && <Linje navn="Fragt" vaerdi={kroner(status.fragtOere)} />}
        {status.beskyttelse && (
          <Linje
            navn="BidHamr Beskyttelse (valgt ved bud)"
            vaerdi={kroner(status.beskyttelseOere)}
          />
        )}
        <div className="flex justify-between border-t border-kant pt-3 text-base font-semibold text-tekst">
          <dt>I alt</dt>
          <dd className="tabular-nums">{kroner(totalOere)}</dd>
        </div>
      </dl>

      {fejl && <FejlBoks tekst={fejl} />}

      {!clientSecret ? (
        <button
          type="button"
          onClick={() => hent()}
          disabled={henter}
          className="btn btn-primaer w-full"
        >
          {henter ? "Henter betaling…" : "Gå til betaling"}
        </button>
      ) : (
        // key: når beløbet ændres, genindlæses Payment Element med det nye beløb.
        <Elements
          key={`${clientSecret}-${totalOere}`}
          stripe={hentStripe()}
          options={{ clientSecret, appearance: stripeUdseende, locale: "da" }}
        >
          <BetalForm
            handelId={status.handelId}
            totalOere={totalOere}
            laast={henter}
          />
        </Elements>
      )}

      <p className="text-xs text-tekst-svag">
        Betalingen håndteres sikkert af Stripe. Sælgeren får først pengene, når
        du har godkendt varen.
      </p>
    </div>
  );
}

function Linje({ navn, vaerdi }: { navn: string; vaerdi: string }) {
  return (
    <div className="flex justify-between gap-4 text-tekst-daempet">
      <dt>{navn}</dt>
      <dd className="tabular-nums text-tekst">{vaerdi}</dd>
    </div>
  );
}

function BetalForm({
  handelId,
  totalOere,
  laast,
}: {
  handelId: string;
  totalOere: number;
  laast: boolean;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  async function betal(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSender(true);
    setFejl(null);
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/mine-handler/${handelId}?betaling=retur`,
      },
    });
    // Kommer vi hertil, er betalingen ikke gennemført (ellers omdirigeres der).
    setFejl(error?.message ?? "Betalingen kunne ikke gennemføres. Prøv igen.");
    setSender(false);
  }

  return (
    <form onSubmit={betal} className="space-y-4">
      <PaymentElement options={{ layout: "tabs" }} />
      {fejl && <FejlBoks tekst={fejl} />}
      <button
        type="submit"
        disabled={!stripe || sender || laast}
        className="btn btn-primaer w-full"
      >
        {sender ? "Betaler…" : `Betal ${kroner(totalOere)}`}
      </button>
      {/* Kun tekst - ændrer ikke betalingen. Åbner i ny fane, så betalingen ikke afbrydes. */}
      <p className="text-center text-[13px] text-tekst-daempet">
        Ved at betale accepterer du BidHamrs{" "}
        <a
          href={BETINGELSER_STI}
          target="_blank"
          rel="noopener"
          className="font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          brugerbetingelser
          <span className="sr-only"> (åbner i et nyt vindue)</span>
        </a>
        .
      </p>
    </form>
  );
}

export { FejlBoks };
