"use client";

// Vises i betalingsformularerne (checkout, boost, returfragt, gem kort), hvis
// Stripe.js ikke kan bruges - i stedet for en "Betal"-knap, der bare
// forbliver grå. Selve fejlen er allerede sendt til /admin/drift af
// hentStripe().
import { useEffect, useState } from "react";
import { hentStripe, STRIPE_IKKE_INDLAEST } from "@/lib/stripeKlient";

export default function StripeIndlaesningsfejl({ className = "mt-3" }: { className?: string }) {
  const [fejl, setFejl] = useState(false);
  useEffect(() => {
    let aktiv = true;
    hentStripe().then((s) => {
      if (aktiv && !s) setFejl(true);
    });
    return () => {
      aktiv = false;
    };
  }, []);
  if (!fejl) return null;
  return (
    <p role="alert" className={`${className} rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst`}>
      {STRIPE_IKKE_INDLAEST}
    </p>
  );
}
