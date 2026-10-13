"use client";

// Lille checkout for returfragten i en sag: Stripes Payment Element (kort,
// MobilePay, Apple Pay, Google Pay - som den øvrige checkout) og knappen
// "Betal returfragt (X kr.)". Beløbet er PaymentIntentens (serveren har låst
// det). foerBetaling gemmer køberens adresse, før Stripe trækker pengene.
// Returkoden laves først, når Stripe har bekræftet betalingen (webhook).
import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { hentStripe, stripeUdseende } from "@/lib/stripeKlient";
import { kroner } from "@/lib/kroner";

type Props = {
  clientSecret: string;
  customerSessionClientSecret: string | null;
  tradeId: string;
  beloebOere: number;
  // Adressefelterne (vises over betalingen).
  children: ReactNode;
  // Validerer og gemmer adressen. false = stop (fejlen vises af kalderen).
  foerBetaling: () => Promise<boolean>;
  onFejl: (tekst: string | null) => void;
  onGenstart: () => void;
};

export default function ReturfragtBetaling(props: Props) {
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

function BetalForm({ tradeId, beloebOere, children, foerBetaling, onFejl, onGenstart }: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [sender, setSender] = useState(false);
  const klar = Boolean(stripe && elements);

  async function betal(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || sender) return;
    setSender(true);
    onFejl(null);
    try {
      if (!(await foerBetaling())) return;
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/mine-handler/${tradeId}?returfragt=retur`,
        },
      });
      // Kommer vi hertil, er betalingen ikke gennemført (ellers omdirigeres der).
      if (error?.code === "payment_intent_unexpected_state" && error.payment_intent?.status === "succeeded") {
        router.replace(`/mine-handler/${tradeId}?returfragt=retur`);
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
    <form onSubmit={betal} method="post" noValidate aria-busy={sender || undefined} className="mt-5">
      {children}
      <div className="mt-5">
        <h3 className="mb-2 text-sm font-medium text-tekst">Betaling</h3>
        <PaymentElement
          options={{ layout: { type: "accordion", defaultCollapsed: false, radios: "always", spacedAccordionItems: true } }}
        />
      </div>
      <button
        type="submit"
        disabled={!klar || sender}
        aria-busy={sender || undefined}
        className="btn btn-primaer mt-5 w-full sm:w-auto"
      >
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        Betal returfragt ({kroner(beloebOere)}.)
      </button>
      <p className="mt-2 text-[13px] text-tekst-svag">Betalingen håndteres af vores betalingspartner Stripe.</p>
    </form>
  );
}
