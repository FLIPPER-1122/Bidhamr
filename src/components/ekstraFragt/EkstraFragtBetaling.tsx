"use client";

// Betaling af en ekstraregning for fragt: Stripes Payment Element (kort,
// MobilePay, Revolut Pay, Apple Pay, Google Pay - samme metoder som
// returfragt og boost, aldrig Link/Klarna) og knappen "Betal X kr.".
// Beløbet er PaymentIntentens (serveren har låst det fra databasen).
// Regningen markeres betalt af webhooken eller returen til handelssiden
// (synkEkstraFragtRetur) - aldrig fra browseren.
// Indlæses kun, når sælgeren trykker "Betal" (dynamic import), så Stripe.js
// ikke hentes på alle handelssider.
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { PAYMENT_ELEMENT_WALLETS } from "@/lib/betaling/betalingsmetoder";
import { hentStripe, stripeUdseende } from "@/lib/stripeKlient";
import StripeIndlaesningsfejl from "@/components/betaling/StripeIndlaesningsfejl";
import { kroner } from "@/lib/kroner";

type Props = {
  clientSecret: string;
  customerSessionClientSecret: string | null;
  beloebOere: number;
  // Handelssiden, Stripe sender tilbage til (fx "/mine-handler/<id>").
  returSti: string;
  onFejl: (tekst: string | null) => void;
  onGenstart: () => void;
  onAnnuller: () => void;
};

export default function EkstraFragtBetaling(props: Props) {
  return (
    <Elements
      key={`${props.clientSecret}-${props.customerSessionClientSecret ?? ""}`}
      stripe={hentStripe()}
      options={{
        clientSecret: props.clientSecret,
        ...(props.customerSessionClientSecret ? { customerSessionClientSecret: props.customerSessionClientSecret } : {}),
        appearance: stripeUdseende,
        locale: "da",
      }}
    >
      <BetalForm {...props} />
    </Elements>
  );
}

function BetalForm({ beloebOere, returSti, onFejl, onGenstart, onAnnuller }: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [sender, setSender] = useState(false);
  const klar = Boolean(stripe && elements);
  const retur = `${returSti}?ekstrafragt=retur`;

  async function betal(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || sender) return;
    setSender(true);
    onFejl(null);
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: `${window.location.origin}${retur}` },
      });
      // Kommer vi hertil, er betalingen ikke gennemført (ellers omdirigeres der).
      if (error?.code === "payment_intent_unexpected_state" && error.payment_intent?.status === "succeeded") {
        router.replace(`${retur}&payment_intent=${encodeURIComponent(error.payment_intent.id)}`);
        router.refresh();
        return;
      }
      if (error?.code === "payment_intent_unexpected_state" && error.payment_intent?.status === "canceled") {
        onGenstart();
        return;
      }
      onFejl(error?.message ?? "Betalingen gik ikke igennem. Prøv igen, eller vælg en anden betalingsmetode.");
    } finally {
      setSender(false);
    }
  }

  return (
    <form onSubmit={betal} method="post" noValidate aria-busy={sender || undefined} className="mt-4">
      <PaymentElement
        options={{
          layout: { type: "accordion", defaultCollapsed: false, radios: "always", spacedAccordionItems: true },
          // Link (Stripes "gem mine oplysninger") vises aldrig (betalingsmetoder.ts).
          wallets: PAYMENT_ELEMENT_WALLETS,
        }}
      />
      <StripeIndlaesningsfejl />
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={!klar || sender}
          aria-busy={sender || undefined}
          className="btn btn-primaer btn-stor w-full sm:w-auto"
        >
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Betal {kroner(beloebOere)}.
        </button>
        <button type="button" onClick={onAnnuller} disabled={sender} className="btn btn-tekst min-h-11 self-center sm:self-auto">
          Fortryd
        </button>
      </div>
      <p className="mt-2 text-[13px] text-tekst-svag">Betalingen håndteres af vores betalingspartner Stripe.</p>
    </form>
  );
}
