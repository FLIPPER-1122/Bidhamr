"use client";

// Knapper, der sender firmaet til Stripe: "Betal for din pakke" (Checkout)
// og "Skift betalingskort" (kundeportalen). Adressen hentes via
// /api/offentlig (ikke en server action - firmakonti må før lancering ikke
// kalde server actions, se src/lib/supabase/middleware.ts).
// Vi sender kun videre til Stripes egne https-adresser.
import { useRef, useState, useTransition } from "react";
import { kaldOffentligHandling } from "@/lib/offentligHandling";
import { FIRMA_BETALING as B } from "@/lib/tekster/erhverv";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER } from "@/components/erhverv/stil";

const STRIPE_VAERTER = new Set(["checkout.stripe.com", "billing.stripe.com", "invoice.stripe.com"]);

export function erStripeAdresse(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && STRIPE_VAERTER.has(u.host);
  } catch {
    return false;
  }
}

export default function StripeKnap({
  handling,
  tekst,
  primaer = true,
}: {
  handling: "firma-betal" | "firma-betalingskort";
  tekst: string;
  primaer?: boolean;
}) {
  const [fejl, setFejl] = useState<string | null>(null);
  const [sender, start] = useTransition();
  const fejlRef = useRef<HTMLParagraphElement>(null);

  function klik() {
    setFejl(null);
    start(async () => {
      const res = await kaldOffentligHandling<{ ok: true; url: string }>(handling, new FormData());
      if ("url" in res && erStripeAdresse(res.url)) {
        window.location.assign(res.url);
        // Bliv i "sender"-tilstand, mens browseren skifter side.
        await new Promise(() => {});
        return;
      }
      setFejl("fejl" in res && res.fejl ? res.fejl : B.fejl);
      window.requestAnimationFrame(() => fejlRef.current?.focus());
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={klik}
        disabled={sender}
        aria-busy={sender || undefined}
        className={`${primaer ? E_KNAP_PRIMAER : E_KNAP_SEKUNDAER} w-full sm:w-auto`}
      >
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        {sender ? B.knapSender : tekst}
      </button>
      {fejl && (
        <p
          ref={fejlRef}
          tabIndex={-1}
          role="alert"
          className="mt-3 rounded-xl border-2 border-fejl-kant bg-fejl-bg p-4 text-[18px] font-semibold text-fejl-tekst outline-none"
        >
          {fejl}
        </p>
      )}
    </div>
  );
}
