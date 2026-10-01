"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import Nedtaelling from "@/components/betaling/Nedtaelling";
import {
  genopsaetAuktion,
  sendAndenchanceTilbud,
  type AndenchanceStatus,
} from "@/app/actions/andenchance";
import { VARIGHEDER, type VarighedDage } from "@/lib/auktionRegler";
import { dato, kroner } from "./format";

const STATUS_TEKST: Record<string, string> = {
  afventer: "Venter på svar",
  accepteret: "Accepteret",
  afvist: "Afvist",
  udloebet: "Udløbet",
  annulleret: "Trukket tilbage",
};

type Props = {
  tradeId: string;
  auktionId: string;
  status: AndenchanceStatus;
  standardStartpris: number;
};

export default function SaelgerUbetaltBoks({ tradeId, auktionId, status, standardStartpris }: Props) {
  const router = useRouter();
  const [visGenopsaet, setVisGenopsaet] = useState(false);

  // Næste byders bud kendes først, når tilbuddet er oprettet (databasen
  // vælger byderen); hentAndenchanceStatus returnerer det ikke på forhånd.
  const tidligere = status.tilbud.filter((t) => t.status !== "afventer");
  const harHistorik = tidligere.length > 0;
  const afsluttet = Boolean(status.nyHandelId || status.genopsatAuktionId);

  return (
    <section className="rounded-2xl border border-kant bg-white p-5 sm:p-6">
      <h2 className="font-serif text-xl font-semibold text-tekst">Køberen betalte ikke</h2>
      <p className="mt-1 text-sm text-tekst-daempet">
        Køberen betalte ikke inden fristen. Handlen er annulleret.
      </p>

      {status.nyHandelId && (
        <div className="mt-4 rounded-xl border border-[#B9D8CC] bg-groen-lys p-4 text-sm text-groen-mork">
          <p className="font-semibold">Næste byder har sagt ja</p>
          <p className="mt-1">Køberen har 24 timer til at betale.</p>
          <Link href={`/mine-handler/${status.nyHandelId}`} className="btn btn-sekundaer btn-lille mt-3">
            Gå til den nye handel
          </Link>
        </div>
      )}

      {status.genopsatAuktionId && (
        <div className="mt-4 rounded-xl border border-[#B9D8CC] bg-groen-lys p-4 text-sm text-groen-mork">
          <p className="font-semibold">Varen er sat op igen</p>
          <Link href={`/auktion/${status.genopsatAuktionId}`} className="btn btn-sekundaer btn-lille mt-3">
            Se den nye auktion
          </Link>
        </div>
      )}

      {status.aktivtTilbud && (
        <div className="mt-4 rounded-xl border border-[#F5D9B0] bg-[#FEF3E2] p-4 text-sm text-[#8A4210]">
          <p className="font-semibold">Tilbudt til næste byder for {kroner(status.aktivtTilbud.budOere)}</p>
          <p className="mt-1">
            Venter på svar ·{" "}
            <span className="font-semibold">
              <Nedtaelling til={status.aktivtTilbud.udloeber} />
            </span>
          </p>
          <p className="mt-1 text-xs">Du får en mail, når byderen har svaret.</p>
        </div>
      )}

      {!afsluttet && !status.aktivtTilbud && harHistorik && !status.harFlereBydere && (
        <p className="mt-4 rounded-xl bg-neutral-50 px-4 py-3 text-sm text-tekst-daempet">
          Der er ikke flere bydere.
        </p>
      )}

      {(status.kanTilbyde || status.kanGenopsaette) && (
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {status.kanTilbyde && (
            <BekraeftDialog
              triggerLabel={harHistorik ? "Send til næste byder" : "Tilbyd til næsthøjeste byder"}
              triggerClassName="btn btn-primaer w-full sm:w-auto"
              title="Tilbyd varen til næste byder?"
              description="Varen tilbydes til den næsthøjeste byder for det beløb, personen selv bød. Byderen har 24 timer til at svare. Beløbet vises, når tilbuddet er sendt."
              confirmLabel="Send tilbud"
              onConfirm={async () => {
                const svar = await sendAndenchanceTilbud(tradeId);
                if ("fejl" in svar) return { fejl: svar.fejl };
              }}
              onSuccess={() => router.refresh()}
            />
          )}
          {status.kanGenopsaette && !visGenopsaet && (
            <button
              type="button"
              onClick={() => setVisGenopsaet(true)}
              className="btn btn-sekundaer w-full sm:w-auto"
            >
              Sæt varen op igen (gratis)
            </button>
          )}
        </div>
      )}

      {status.kanGenopsaette && visGenopsaet && (
        <GenopsaetForm
          auktionId={auktionId}
          standardStartpris={standardStartpris}
          onAnnuller={() => setVisGenopsaet(false)}
        />
      )}

      {status.tilbud.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-tekst">Tilbud til andre bydere</h3>
          <ul className="mt-2 divide-y divide-kant rounded-xl border border-kant">
            {status.tilbud.map((t, i) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span className="text-tekst">
                  Byder {status.tilbud.length - i} · {kroner(t.budOere)}
                  <span className="block text-xs text-tekst-svag">Sendt {dato(t.oprettet)}</span>
                </span>
                <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700">
                  {STATUS_TEKST[t.status] ?? t.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function GenopsaetForm({
  auktionId,
  standardStartpris,
  onAnnuller,
}: {
  auktionId: string;
  standardStartpris: number;
  onAnnuller: () => void;
}) {
  const router = useRouter();
  const [startpris, setStartpris] = useState(standardStartpris);
  const [varighed, setVarighed] = useState<VarighedDage>(3);
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function send(e: React.FormEvent) {
    e.preventDefault();
    setFejl(null);
    startTransition(async () => {
      const svar = await genopsaetAuktion(auktionId, startpris, varighed);
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }
      router.push(`/auktion/${svar.auktionId}`);
    });
  }

  return (
    <form onSubmit={send} className="mt-5 space-y-4 rounded-xl border border-kant bg-neutral-50 p-4">
      <p className="text-sm text-tekst-daempet">
        Varen sættes op som en ny auktion. Det er gratis.
      </p>
      <div>
        <label htmlFor="genopsaet-startpris" className="block text-sm font-medium text-tekst">
          Startpris (kr.)
        </label>
        <input
          id="genopsaet-startpris"
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          required
          value={Number.isNaN(startpris) ? "" : startpris}
          onChange={(e) => setStartpris(e.target.value === "" ? NaN : Number(e.target.value))}
          className="mt-1.5 w-full rounded-lg border border-kant-staerk bg-white px-3 py-2.5 text-sm text-tekst outline-none focus:border-groen focus:ring-1 focus:ring-groen"
        />
      </div>
      <fieldset>
        <legend className="block text-sm font-medium text-tekst">Varighed</legend>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {VARIGHEDER.map((v) => (
            <button
              key={v.dage}
              type="button"
              aria-pressed={varighed === v.dage}
              onClick={() => setVarighed(v.dage)}
              className={`rounded-lg border px-4 py-2 text-sm font-medium ${
                varighed === v.dage
                  ? "border-orange-knap bg-orange-knap text-white"
                  : "border-kant-staerk bg-white text-neutral-700"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </fieldset>
      {fejl && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {fejl}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="submit" disabled={pending} className="btn btn-primaer w-full sm:w-auto">
          {pending ? "Sætter op…" : "Sæt varen op igen"}
        </button>
        <button type="button" onClick={onAnnuller} disabled={pending} className="btn btn-tekst w-full sm:w-auto">
          Annullér
        </button>
      </div>
    </form>
  );
}
