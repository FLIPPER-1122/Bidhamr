"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { sendPakke, markerModtaget, godkendPakke } from "@/app/actions/trades";
import BekraeftDialog from "@/components/BekraeftDialog";
import StjerneVaelger from "@/components/StjerneVaelger";

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
        className="rounded-lg bg-orange-knap px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-knap-mork disabled:opacity-50"
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
        className="rounded-lg bg-orange-knap px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-knap-mork disabled:opacity-50"
      >
        {pending ? "Gemmer…" : "Jeg har modtaget pakken"}
      </button>
      {fejl && <p className="mt-2 text-sm text-red-600">{fejl}</p>}
    </div>
  );
}

const KOMMENTAR_MAKS = 1000;

// TRIN 2: godkendelse udbetaler til sælgeren og kan ikke fortrydes - derfor
// bekræftelsesdialogen. Køberen bedømmer sælgeren i samme trin
// (ROADMAP-BESLUTNINGER afsnit 6): stjerner er påkrævet, kommentaren valgfri.
export function GodkendPakkeKnap({ tradeId }: { tradeId: string }) {
  const router = useRouter();
  const [stjerner, setStjerner] = useState(0);
  const [kommentar, setKommentar] = useState("");
  const antalTegn = Array.from(kommentar).length;

  return (
    <BekraeftDialog
      triggerLabel="Godkend pakke"
      title="Godkend varen og bedøm sælgeren"
      description="Din bedømmelse vises på sælgerens profil. Når du godkender, udbetales pengene til sælgeren – betalingen håndteres af vores betalingspartner Stripe. Det kan ikke fortrydes."
      confirmLabel="Godkend og bedøm"
      confirmDisabled={stjerner === 0 || antalTegn > KOMMENTAR_MAKS}
      onConfirm={() => godkendPakke(tradeId, stjerner, kommentar)}
      onSuccess={() => router.refresh()}
    >
      <div className="space-y-4">
        <StjerneVaelger
          legend="Hvordan var handlen med sælgeren?"
          vaerdi={stjerner}
          onChange={setStjerner}
        />
        <div>
          <label
            htmlFor={`kommentar-${tradeId}`}
            className="mb-1.5 block text-sm font-medium text-neutral-900"
          >
            Kommentar <span className="font-normal text-tekst-svag">(valgfrit)</span>
          </label>
          <textarea
            id={`kommentar-${tradeId}`}
            value={kommentar}
            onChange={(e) => setKommentar(e.target.value)}
            maxLength={KOMMENTAR_MAKS}
            rows={3}
            placeholder="Fortæl kort om din oplevelse"
            aria-describedby={`kommentar-taeller-${tradeId}`}
            className="w-full resize-none rounded-xl border border-kant-staerk bg-white px-4 py-2.5 text-[15px] text-tekst placeholder:text-pladsholder outline-none focus:border-groen focus:outline-2 focus:outline-groen/25"
          />
          <p
            id={`kommentar-taeller-${tradeId}`}
            className="mt-1 text-right text-xs text-tekst-svag"
          >
            {antalTegn}/{KOMMENTAR_MAKS} tegn
          </p>
        </div>
      </div>
    </BekraeftDialog>
  );
}
