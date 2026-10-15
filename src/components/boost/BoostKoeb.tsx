"use client";

// "Køb 100 point – 39 kr." (Min konto -> Boost-point). Serveren låser pris
// og point og laver PaymentIntenten på BidHamrs platformskonto
// (startBoostKoebAction); her vises Stripes Payment Element (kort,
// MobilePay, Apple Pay, Google Pay - et gemt kort forudfylder kun). Pointene
// krediteres først, når Stripe har bekræftet betalingen (webhook eller
// returen til siden) - aldrig fra browseren.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { hentStripe, stripeUdseende } from "@/lib/stripeKlient";
import { startBoostKoebAction } from "@/app/actions/boost";
import { BOOST_TEKST } from "@/lib/boost/tekster";

type Start = { clientSecret: string; customerSessionClientSecret: string | null; beloebOere: number };

export default function BoostKoeb({
  point,
  prisOere,
  kraevSamtykke,
  retur,
}: {
  point: number;
  prisOere: number;
  kraevSamtykke: boolean;
  // Hvor brugeren kom fra (fx sin auktion) - vises som link efter købet.
  retur: string | null;
}) {
  const [start, setStart] = useState<Start | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [henter, setHenter] = useState(false);
  const [samtykke, setSamtykke] = useState(false);

  async function begynd() {
    if (henter) return;
    if (kraevSamtykke && !samtykke) {
      setFejl(BOOST_TEKST.samtykkeMangler);
      return;
    }
    setHenter(true);
    setFejl(null);
    try {
      const r = await startBoostKoebAction(samtykke);
      if ("fejl" in r) setFejl(r.fejl);
      else setStart({ clientSecret: r.clientSecret, customerSessionClientSecret: r.customerSessionClientSecret, beloebOere: r.beloebOere });
    } catch {
      setFejl(BOOST_TEKST.fejl.fejl);
    } finally {
      setHenter(false);
    }
  }

  return (
    <div>
      {!start && (
        <>
          {kraevSamtykke && (
            <label className="mt-3 flex items-start gap-2 text-sm text-tekst">
              <input
                type="checkbox"
                checked={samtykke}
                onChange={(e) => setSamtykke(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-groen"
              />
              <span>{BOOST_TEKST.samtykkeTekst}</span>
            </label>
          )}
          <button
            type="button"
            onClick={begynd}
            disabled={henter}
            aria-busy={henter || undefined}
            className="btn btn-primaer mt-4 w-full sm:w-auto"
          >
            {henter && <span className="btn-spinner" aria-hidden="true" />}
            {BOOST_TEKST.koebKnap(point, prisOere)}
          </button>
        </>
      )}
      {start && (
        <Elements
          key={`${start.clientSecret}-${start.customerSessionClientSecret ?? ""}`}
          stripe={hentStripe()}
          options={{
            clientSecret: start.clientSecret,
            ...(start.customerSessionClientSecret ? { customerSessionClientSecret: start.customerSessionClientSecret } : {}),
            appearance: stripeUdseende,
            locale: "da",
          }}
        >
          <BetalForm beloebOere={start.beloebOere} retur={retur} onFejl={setFejl} onGenstart={() => setStart(null)} />
        </Elements>
      )}
      {fejl && (
        <p role="alert" className="mt-3 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
      <p className="mt-2 text-[13px] text-tekst-svag">{BOOST_TEKST.betalingIntro}</p>
    </div>
  );
}

function BetalForm({
  beloebOere,
  retur,
  onFejl,
  onGenstart,
}: {
  beloebOere: number;
  retur: string | null;
  onFejl: (t: string | null) => void;
  onGenstart: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [sender, setSender] = useState(false);
  const klar = Boolean(stripe && elements);
  const returSti = `/konto/boost?boost=retur${retur ? `&fra=${encodeURIComponent(retur)}` : ""}`;

  async function betal(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || sender) return;
    setSender(true);
    onFejl(null);
    try {
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: `${window.location.origin}${returSti}` },
      });
      // Kommer vi hertil, er betalingen ikke gennemført (ellers omdirigeres der).
      if (error?.code === "payment_intent_unexpected_state" && error.payment_intent?.status === "succeeded") {
        router.replace(`${returSti}&payment_intent=${encodeURIComponent(error.payment_intent.id)}`);
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
        options={{ layout: { type: "accordion", defaultCollapsed: false, radios: "always", spacedAccordionItems: true } }}
      />
      <button type="submit" disabled={!klar || sender} aria-busy={sender || undefined} className="btn btn-primaer mt-5 w-full sm:w-auto">
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        {BOOST_TEKST.betalKnap(beloebOere)}
      </button>
    </form>
  );
}
