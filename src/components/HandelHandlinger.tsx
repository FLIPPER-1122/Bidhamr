"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { sendPakke, markerModtaget, godkendPakke } from "@/app/actions/trades";
import BekraeftDialog from "@/components/BekraeftDialog";

export function SendPakkeForm({ tradeId }: { tradeId: string }) {
  const router = useRouter();
  const [tracking, setTracking] = useState("");
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    startTransition(async () => {
      const resultat = await sendPakke(tradeId, tracking);
      if (resultat?.fejl) setFejl(resultat.fejl);
      else router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor="tracking" className="block text-sm font-medium text-neutral-700">
          Sporingsnummer
        </label>
        <input
          id="tracking"
          type="text"
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          placeholder="Fx 00570012345678"
          className="mt-1.5 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </div>
      <button
        type="submit"
        disabled={pending || !tracking.trim()}
        className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
      >
        {pending ? "Gemmer…" : "Send pakke"}
      </button>
      {fejl && <p className="text-sm text-red-600">{fejl}</p>}
    </form>
  );
}

// TRIN 1: kvittering for pakken. Ingen penge flyttes, så ingen dialog -
// handlingen kan ikke gøre skade og skal være let at komme videre fra.
export function MarkerModtagetKnap({ tradeId }: { tradeId: string }) {
  const router = useRouter();
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleClick() {
    setFejl(null);
    startTransition(async () => {
      const resultat = await markerModtaget(tradeId);
      if (resultat?.fejl) setFejl(resultat.fejl);
      else router.refresh();
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
      >
        {pending ? "Gemmer…" : "Jeg har modtaget pakken"}
      </button>
      {fejl && <p className="mt-2 text-sm text-red-600">{fejl}</p>}
    </div>
  );
}

// TRIN 2: godkendelse udbetaler til sælgeren og kan ikke fortrydes - derfor
// bekræftelsesdialogen.
export function GodkendPakkeKnap({ tradeId }: { tradeId: string }) {
  const router = useRouter();

  return (
    <BekraeftDialog
      triggerLabel="Godkend pakke"
      title="Bekræft dit valg"
      description="Når du godkender pakken, udbetales beløbet til sælgeren. Dette kan ikke trækkes tilbage."
      confirmLabel="Ja, godkend pakken"
      onConfirm={() => godkendPakke(tradeId)}
      onSuccess={() => router.refresh()}
    />
  );
}
