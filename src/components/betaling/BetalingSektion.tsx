"use client";

import { useState, type FormEvent } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { startBetaling, type Betalingsstatus } from "@/app/actions/betaling";
import { hentStripe, stripeUdseende } from "@/lib/stripeKlient";
import { kroner } from "@/lib/kroner";

// Køberens betaling af en vundet auktion. Alle beløb kommer fra serveren -
// klienten lægger aldrig noget sammen.
export default function BetalingSektion({ status }: { status: Betalingsstatus }) {
  const [beskyttelse, setBeskyttelse] = useState(status.beskyttelse);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [totalOere, setTotalOere] = useState(status.totalOere);
  // Totalen passer kun til valget, når den kommer fra serveren for netop det valg.
  const [totalErForValg, setTotalErForValg] = useState(true);
  const [henter, setHenter] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  async function hent(medBeskyttelse: boolean) {
    setHenter(true);
    setFejl(null);
    const svar = await startBetaling(status.handelId, { beskyttelse: medBeskyttelse });
    setHenter(false);
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      return false;
    }
    setClientSecret(svar.clientSecret);
    setTotalOere(svar.totalOere);
    setTotalErForValg(true);
    return true;
  }

  async function skiftBeskyttelse(til: boolean) {
    const foer = beskyttelse;
    setBeskyttelse(til);
    setTotalErForValg(false);
    const ok = await hent(til);
    if (!ok) {
      setBeskyttelse(foer);
      setTotalErForValg(true);
    }
  }

  return (
    <div className="space-y-5">
      <dl className="space-y-2 text-sm">
        <Linje navn="Dit bud" vaerdi={kroner(status.budOere)} />
        <Linje navn="Købergebyr (5%)" vaerdi={kroner(status.koebergebyrOere)} />
        {status.fragtOere > 0 && <Linje navn="Fragt" vaerdi={kroner(status.fragtOere)} />}
        {beskyttelse && (
          <Linje navn="BidHamr Beskyttelse" vaerdi={kroner(status.beskyttelsePrisOere)} />
        )}
        <div className="flex justify-between border-t border-kant pt-3 text-base font-semibold text-tekst">
          <dt>I alt</dt>
          <dd className="tabular-nums">{totalErForValg ? kroner(totalOere) : "Beregnes…"}</dd>
        </div>
      </dl>

      <label className="flex cursor-pointer gap-3 rounded-xl border border-kant bg-groen-lys p-4">
        <input
          type="checkbox"
          checked={beskyttelse}
          disabled={henter}
          onChange={(e) => skiftBeskyttelse(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-[#1E5E4A]"
        />
        <span className="text-sm">
          <span className="font-semibold text-groen-mork">
            Tilføj BidHamr Beskyttelse (+{kroner(status.beskyttelsePrisOere)})
          </span>
          <span className="mt-1 block text-tekst-daempet">
            Får du ikke varen, eller er den væsentligt anderledes end beskrevet,
            får du pengene tilbage. Valgfrit.
          </span>
        </span>
      </label>

      {fejl && <FejlBoks tekst={fejl} />}

      {!clientSecret ? (
        <button
          type="button"
          onClick={() => hent(beskyttelse)}
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
            laast={henter || !totalErForValg}
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

export function FejlBoks({ tekst }: { tekst: string }) {
  return (
    <p
      role="alert"
      className="rounded-xl border border-[#F3C4C4] bg-[#FDECEC] px-4 py-3 text-sm text-[#A32020]"
    >
      {tekst}
    </p>
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
    </form>
  );
}
