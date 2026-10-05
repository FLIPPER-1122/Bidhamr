"use client";

import { useState, type FormEvent } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { hentStripe, stripeUdseende } from "@/lib/stripeKlient";
import { FejlBoks } from "@/components/betaling/FejlBoks";

// "Gem et kort" på Min konto. Indlæses dynamisk fra KontoBetaling, så
// Stripe.js først hentes, når brugeren har bedt om at gemme et kort.
export default function GemKortStripe({
  clientSecret,
  onAnnuller,
}: {
  clientSecret: string;
  onAnnuller: () => void;
}) {
  return (
    <Elements stripe={hentStripe()} options={{ clientSecret, appearance: stripeUdseende, locale: "da" }}>
      <GemKortForm onAnnuller={onAnnuller} />
    </Elements>
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
