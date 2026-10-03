"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { visAfhentningskode, bekraeftAfhentning } from "@/app/actions/afhentning";
import BekraeftDialog from "@/components/BekraeftDialog";
import StjerneVaelger from "@/components/StjerneVaelger";

const KOMMENTAR_MAKS = 1000;

function KodeVisning({ kode }: { kode: string }) {
  return (
    <div className="rounded-xl border border-kant bg-neutral-50 px-4 py-5 text-center">
      <p className="text-sm text-tekst-daempet">Din afhentningskode</p>
      <p
        className="mt-1 font-mono text-4xl font-bold tracking-[0.3em] text-tekst sm:text-5xl"
        aria-label={`Afhentningskode ${kode.split("").join(" ")}`}
      >
        {kode}
      </p>
      <p className="mt-3 text-sm text-tekst-daempet">
        Vis koden til sælgeren, når du har fået varen og har tjekket den.
      </p>
    </div>
  );
}

// Køberen: giv sælgeren 1-5 stjerner -> koden vises. Har køberen allerede
// bedømt, sender siden koden med, og den vises med det samme.
export function VisAfhentningskode({
  tradeId,
  kode: startKode,
}: {
  tradeId: string;
  kode: string | null;
}) {
  const router = useRouter();
  const [kode, setKode] = useState<string | null>(startKode);
  const [stjerner, setStjerner] = useState(0);
  const [kommentar, setKommentar] = useState("");
  const antalTegn = Array.from(kommentar).length;

  if (kode) return <KodeVisning kode={kode} />;

  return (
    <BekraeftDialog
      triggerLabel="Vis afhentningskode"
      title="Bedøm sælgeren og få din kode"
      description="Din bedømmelse vises på sælgerens profil. Vis først koden til sælgeren, når du står med varen og har tjekket den: når sælgeren har indtastet koden, frigives pengene til sælgeren med det samme, og du kan ikke klage over handlen bagefter. Betalingen håndteres af vores betalingspartner Stripe."
      confirmLabel="Bedøm og vis kode"
      confirmDisabled={stjerner === 0 || antalTegn > KOMMENTAR_MAKS}
      onConfirm={async () => {
        const svar = await visAfhentningskode(tradeId, stjerner, kommentar);
        if ("fejl" in svar) return svar;
        setKode(svar.kode);
      }}
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
            htmlFor={`afhentning-kommentar-${tradeId}`}
            className="mb-1.5 block text-sm font-medium text-neutral-900"
          >
            Kommentar <span className="font-normal text-tekst-svag">(valgfrit)</span>
          </label>
          <textarea
            id={`afhentning-kommentar-${tradeId}`}
            value={kommentar}
            onChange={(e) => setKommentar(e.target.value)}
            maxLength={KOMMENTAR_MAKS}
            rows={3}
            placeholder="Fortæl kort om din oplevelse"
            aria-describedby={`afhentning-taeller-${tradeId}`}
            className="w-full resize-none rounded-xl border border-kant-staerk bg-white px-4 py-2.5 text-[15px] text-tekst placeholder:text-pladsholder outline-none focus:border-groen focus:outline-2 focus:outline-groen/25"
          />
          <p
            id={`afhentning-taeller-${tradeId}`}
            className="mt-1 text-right text-xs text-tekst-svag"
          >
            {antalTegn}/{KOMMENTAR_MAKS} tegn
          </p>
        </div>
      </div>
    </BekraeftDialog>
  );
}

// Sælgeren: indtast køberens kode. Rigtig kode frigiver pengene.
export function IndtastAfhentningskode({ tradeId }: { tradeId: string }) {
  const router = useRouter();
  const [kode, setKode] = useState("");
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ren = kode.replace(/\s/g, "");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    startTransition(async () => {
      const svar = await bekraeftAfhentning(tradeId, ren);
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }
      setKode("");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor={`afhentningskode-${tradeId}`} className="block text-sm font-medium text-neutral-700">
          Indtast køberens kode
        </label>
        <input
          id={`afhentningskode-${tradeId}`}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9 ]*"
          maxLength={7}
          value={kode}
          onChange={(e) => setKode(e.target.value.replace(/[^0-9 ]/g, ""))}
          placeholder="6 cifre"
          aria-describedby={fejl ? `afhentningskode-fejl-${tradeId}` : undefined}
          className="mt-1.5 w-full max-w-xs rounded-lg border border-neutral-200 px-3 py-2.5 font-mono text-lg tracking-[0.2em] outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </div>
      <button
        type="submit"
        disabled={pending || !/^[0-9]{6}$/.test(ren)}
        className="rounded-lg bg-orange-knap px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-knap-mork disabled:opacity-50"
      >
        {pending ? "Tjekker…" : "Bekræft afhentning"}
      </button>
      {fejl && (
        <p id={`afhentningskode-fejl-${tradeId}`} role="alert" className="text-sm text-red-600">
          {fejl}
        </p>
      )}
    </form>
  );
}
