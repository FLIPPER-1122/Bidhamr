"use client";

// Stripes Payment Element i checkout. Formularen har id CHECKOUT_FORM, så
// "Betal X kr."-knappen i prisoversigten (højre på desktop, nederst på
// mobil) kan sende den. Beløbet er PaymentIntentens - klienten lægger intet
// sammen. Kun den rette PaymentIntent (fra startBetaling) bruges.
import { useEffect, type FormEvent } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { hentStripe, stripeUdseende } from "@/lib/stripeKlient";

import { CHECKOUT_FORM } from "@/components/checkout/konstanter";

type Props = {
  clientSecret: string;
  // Stripe CustomerSession (gemt kort vises forvalgt). null = intet gemt kort.
  customerSessionClientSecret: string | null;
  handelId: string;
  sender: boolean;
  onSender: (v: boolean) => void;
  onKlar: (v: boolean) => void;
  onFejl: (tekst: string | null, alleredeBetalt?: boolean) => void;
  // PaymentIntenten er annulleret (fx leveringen er ændret i en anden fane): hent en ny.
  onGenstart: () => void;
};

export default function CheckoutBetaling(props: Props) {
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

function BetalForm({ handelId, sender, onSender, onKlar, onFejl, onGenstart }: Props) {
  const stripe = useStripe();
  const elements = useElements();

  useEffect(() => {
    onKlar(Boolean(stripe && elements));
  }, [stripe, elements, onKlar]);

  async function betal(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || sender) return;
    onSender(true);
    onFejl(null);
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/mine-handler/${handelId}?betaling=retur`,
      },
    });
    // Kommer vi hertil, er betalingen ikke gennemført (ellers omdirigeres der).
    if (error?.code === "payment_intent_unexpected_state" && error.payment_intent?.status === "succeeded") {
      onFejl("Handlen er allerede betalt.", true);
    } else if (error?.code === "payment_intent_unexpected_state" && error.payment_intent?.status === "canceled") {
      onSender(false);
      onGenstart();
      return;
    } else {
      onFejl(error?.message ?? "Betalingen gik ikke igennem. Prøv igen, eller vælg en anden betalingsmetode.");
    }
    onSender(false);
  }

  return (
    <form id={CHECKOUT_FORM} onSubmit={betal} aria-busy={sender || undefined}>
      <PaymentElement
        options={{ layout: { type: "accordion", defaultCollapsed: false, radios: "always", spacedAccordionItems: true } }}
      />
    </form>
  );
}
