"use client";

// Køb af boost-point (Min konto -> Boost-point; auktionens boost-boks linker
// hertil). Brugeren vælger en af pakkerne (boost_pakker via mine_point -
// Filip, 19. okt. 2026) og trykker "Køb 300 point – 99 kr.". Klienten sender
// KUN pakkens id: serveren vælger pris og point, låser dem på købet og laver
// PaymentIntenten på BidHamrs platformskonto (startBoostKoebAction). Her
// vises Stripes Payment Element (kort, MobilePay, Revolut Pay, Apple Pay, Google Pay - et
// gemt kort forudfylder kun). Pointene krediteres først, når Stripe har
// bekræftet betalingen (webhook eller returen til siden) - aldrig fra
// browseren. Vælges en anden pakke, skjules betalingen, og der startes et
// nyt køb (serveren annullerer det gamle).

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { PAYMENT_ELEMENT_WALLETS } from "@/lib/betaling/betalingsmetoder";
import { hentStripe, stripeUdseende } from "@/lib/stripeKlient";
import { startBoostKoebAction } from "@/app/actions/boost";
import { BOOST_TEKST } from "@/lib/boost/tekster";
import StripeIndlaesningsfejl from "@/components/betaling/StripeIndlaesningsfejl";

// mine_point.pakker[] (id null = før migrationen 20261026010000: kun
// standardpakken, købes uden id).
export type BoostPakke = {
  id: string | null;
  point: number;
  pris_oere: number;
  boost: number;
  spar_oere: number;
  bedste: boolean;
};

type Start = { clientSecret: string; customerSessionClientSecret: string | null; beloebOere: number; pakke: string | null };

export default function BoostKoeb({
  pakker,
  kraevSamtykke,
  retur,
}: {
  pakker: BoostPakke[];
  kraevSamtykke: boolean;
  // Hvor brugeren kom fra (fx sin auktion) - vises som link efter købet.
  retur: string | null;
}) {
  const [valgtIndeks, setValgtIndeks] = useState(0);
  const [start, setStart] = useState<Start | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [henter, setHenter] = useState(false);
  const [sender, setSender] = useState(false);
  const [samtykke, setSamtykke] = useState(false);
  const valgt = pakker[Math.min(valgtIndeks, pakker.length - 1)];

  function vaelg(i: number) {
    if (sender || henter || i === valgtIndeks) return;
    setValgtIndeks(i);
    // Betalingen for den forrige pakke skjules; et nyt køb startes med knappen.
    setStart(null);
    setFejl(null);
  }

  async function begynd() {
    if (henter || !valgt) return;
    if (kraevSamtykke && !samtykke) {
      setFejl(BOOST_TEKST.samtykkeMangler);
      return;
    }
    setHenter(true);
    setFejl(null);
    try {
      const r = await startBoostKoebAction(samtykke, valgt.id);
      if ("fejl" in r) setFejl(r.fejl);
      else
        setStart({
          clientSecret: r.clientSecret,
          customerSessionClientSecret: r.customerSessionClientSecret,
          beloebOere: r.beloebOere,
          pakke: r.pakke,
        });
    } catch {
      setFejl(BOOST_TEKST.fejl.fejl);
    } finally {
      setHenter(false);
    }
  }

  if (!valgt) return null;

  return (
    <div className="mt-5">
      <fieldset disabled={sender || henter}>
        <legend className="text-[15px] font-semibold text-tekst">{BOOST_TEKST.pakkerTitel}</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {pakker.map((p, i) => (
            <PakkeKort key={p.id ?? `pakke-${i}`} pakke={p} valgt={i === valgtIndeks} onVaelg={() => vaelg(i)} />
          ))}
        </div>
      </fieldset>

      {!start && (
        <>
          {kraevSamtykke && (
            <label className="mt-4 flex items-start gap-2 text-sm text-tekst">
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
            {BOOST_TEKST.koebKnap(valgt.point, valgt.pris_oere)}
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
          <BetalForm
            beloebOere={start.beloebOere}
            retur={retur}
            onFejl={setFejl}
            onSender={setSender}
            onGenstart={() => setStart(null)}
          />
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

function PakkeKort({ pakke, valgt, onVaelg }: { pakke: BoostPakke; valgt: boolean; onVaelg: () => void }) {
  return (
    <label
      className={`relative flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border-2 p-3.5 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-groen has-[:disabled]:cursor-default sm:flex-col sm:items-start sm:gap-2 sm:p-4 ${
        valgt ? "border-groen bg-groen-lys" : "border-kant bg-white hover:border-kant-staerk"
      }`}
    >
      <input type="radio" name="boost-pakke" checked={valgt} onChange={onVaelg} className="sr-only" />
      <span className="flex min-w-0 flex-1 items-start gap-3 sm:w-full sm:flex-none">
        <span
          aria-hidden="true"
          className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${valgt ? "border-groen" : "border-kant-staerk"}`}
        >
          {valgt && <span className="h-2.5 w-2.5 rounded-full bg-groen" />}
        </span>
        <span className="min-w-0">
          <span className="block text-[17px] leading-tight font-bold whitespace-nowrap text-tekst">
            {BOOST_TEKST.pakkePoint(pakke.point)}
          </span>
          <span className="block text-[13px] whitespace-nowrap text-tekst-daempet">{BOOST_TEKST.pakkeBoost(pakke.boost)}</span>
          {(pakke.spar_oere > 0 || pakke.bedste) && (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {pakke.spar_oere > 0 && (
                <span className="rounded-full bg-white px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap text-groen-mork ring-1 ring-groen/30">
                  {BOOST_TEKST.spar(pakke.spar_oere)}
                </span>
              )}
              {pakke.bedste && (
                <span className="rounded-full bg-orange-knap px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap text-white">
                  {BOOST_TEKST.bedsteKoeb}
                </span>
              )}
            </span>
          )}
        </span>
      </span>
      <span className="shrink-0 self-start text-[17px] font-semibold whitespace-nowrap text-tekst tabular-nums sm:pl-8">
        {BOOST_TEKST.pakkePris(pakke.pris_oere)}
      </span>
    </label>
  );
}

function BetalForm({
  beloebOere,
  retur,
  onFejl,
  onSender,
  onGenstart,
}: {
  beloebOere: number;
  retur: string | null;
  onFejl: (t: string | null) => void;
  onSender: (v: boolean) => void;
  onGenstart: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [sender, setSender] = useState(false);
  const klar = Boolean(stripe && elements);
  const returSti = `/konto/boost?boost=retur${retur ? `&fra=${encodeURIComponent(retur)}` : ""}`;

  function saetSender(v: boolean) {
    setSender(v);
    onSender(v);
  }

  async function betal(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || sender) return;
    saetSender(true);
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
      saetSender(false);
    }
  }

  return (
    <form onSubmit={betal} method="post" noValidate aria-busy={sender || undefined} className="mt-5">
      <PaymentElement
        options={{
          layout: { type: "accordion", defaultCollapsed: false, radios: "always", spacedAccordionItems: true },
          // Link (Stripes "gem mine oplysninger") vises aldrig (betalingsmetoder.ts).
          wallets: PAYMENT_ELEMENT_WALLETS,
        }}
      />
      <StripeIndlaesningsfejl />
      <button type="submit" disabled={!klar || sender} aria-busy={sender || undefined} className="btn btn-primaer mt-5 w-full sm:w-auto">
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        {BOOST_TEKST.betalKnap(beloebOere)}
      </button>
    </form>
  );
}
