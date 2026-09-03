"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { sendPakke, bekraeftModtagelse } from "@/app/actions/trades";

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

export function BekraeftModtagelseKnap({ tradeId }: { tradeId: string }) {
  const router = useRouter();
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleClick() {
    setFejl(null);
    startTransition(async () => {
      const resultat = await bekraeftModtagelse(tradeId);
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
        {pending ? "Bekræfter…" : "Bekræft modtagelse"}
      </button>
      {fejl && <p className="mt-2 text-sm text-red-600">{fejl}</p>}
    </div>
  );
}
