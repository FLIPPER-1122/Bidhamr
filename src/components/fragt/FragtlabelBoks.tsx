"use client";

// "Lav fragtlabel" for sælgeren på handelssiden. Vises kun, når
// FRAGT_LABELS_AKTIV=true (tjekkes på serveren i siden og i actions).
// TODO(indhold): gennemse teksterne.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import BekraeftDialog from "@/components/BekraeftDialog";
import { annullerFragtlabel, hentFragtlabelLink, lavFragtlabel, type MinForsendelse } from "@/app/actions/fragt";
import {
  PAKKESTOERRELSER,
  PAKKESTOERRELSE_NAVN,
  SPORINGS_NAVN,
  erSporingsType,
  type Pakkestoerrelse,
} from "@/lib/fragt/types";

const STOERRELSE_HJAELP: Record<Pakkestoerrelse, string> = {
  lille: "Fx tøj, bøger, små elektronikting",
  mellem: "Fx sko, køkkenting, mindre legetøj",
  stor: "Fx større elektronik, sportsudstyr",
};

export default function FragtlabelBoks({
  tradeId,
  forsendelse,
}: {
  tradeId: string;
  forsendelse: MinForsendelse | null;
}) {
  const router = useRouter();
  const [stoerrelse, setStoerrelse] = useState<Pakkestoerrelse | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [arbejder, setArbejder] = useState(false);
  const laas = useRef(false);

  async function lav() {
    if (laas.current || !stoerrelse) return;
    laas.current = true;
    setArbejder(true);
    setFejl(null);
    try {
      const r = await lavFragtlabel(tradeId, stoerrelse);
      if ("fejl" in r) setFejl(r.fejl);
      else router.refresh();
    } catch {
      setFejl("Noget gik galt. Prøv igen om lidt.");
    } finally {
      laas.current = false;
      setArbejder(false);
    }
  }

  async function aabnLabel(id: string) {
    setFejl(null);
    try {
      const r = await hentFragtlabelLink(id);
      if ("fejl" in r) setFejl(r.fejl);
      else window.open(r.url, "_blank", "noopener,noreferrer");
    } catch {
      setFejl("Noget gik galt. Prøv igen om lidt.");
    }
  }

  if (forsendelse) {
    const status = erSporingsType(forsendelse.status)
      ? SPORINGS_NAVN[forsendelse.status]
      : forsendelse.status === "annulleres"
        ? "Labelen er ved at blive annulleret"
        : "Labelen er ved at blive lavet";
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-neutral-900">Din fragtlabel</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Print labelen og sæt den på kassen - eller vis QR-koden i pakkeshoppen. Husk stadig at
          tage de to pakkebilleder og markere pakken sendt nedenfor.
        </p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-neutral-500">Sporingsnummer</dt>
          <dd className="font-mono font-medium text-neutral-900">{forsendelse.sporingsnummer ?? "-"}</dd>
          <dt className="text-neutral-500">Størrelse</dt>
          <dd className="text-neutral-900">
            {PAKKESTOERRELSE_NAVN[forsendelse.pakkestoerrelse as Pakkestoerrelse] ?? forsendelse.pakkestoerrelse}
          </dd>
          <dt className="text-neutral-500">Status</dt>
          <dd className="text-neutral-900">{status}</dd>
        </dl>
        {fejl && (
          <p role="alert" className="mt-4 rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
            {fejl}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          {forsendelse.har_label && (
            <button
              type="button"
              onClick={() => aabnLabel(forsendelse.id)}
              className="rounded-lg bg-orange-knap px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-knap-mork"
            >
              Hent label (PDF)
            </button>
          )}
          {forsendelse.status === "oprettet" && (
            <BekraeftDialog
              triggerLabel="Annullér label"
              triggerClassName="rounded-lg border border-neutral-200 px-5 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              title="Annullér fragtlabelen?"
              description="Labelen kan ikke bruges bagefter. Du kan lave en ny, hvis du fx har valgt forkert størrelse."
              confirmLabel="Annullér label"
              cancelLabel="Behold label"
              onConfirm={async () => {
                const r = await annullerFragtlabel(tradeId, forsendelse.id);
                return "fejl" in r ? { fejl: r.fejl } : undefined;
              }}
              onSuccess={() => router.refresh()}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-6">
      <h2 className="text-sm font-semibold text-neutral-900">Lav fragtlabel</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Vælg pakkens størrelse. Du får en label med sporingsnummer og QR-kode, som du kan
        printe eller vise i pakkeshoppen.
      </p>
      <fieldset className="mt-4 grid gap-2 sm:grid-cols-3" disabled={arbejder}>
        <legend className="sr-only">Pakkestørrelse</legend>
        {PAKKESTOERRELSER.map((s) => (
          <label
            key={s}
            className={`cursor-pointer rounded-lg border px-3 py-2.5 text-sm ${
              stoerrelse === s ? "border-groen bg-groen-lys" : "border-neutral-200"
            }`}
          >
            <input
              type="radio"
              name="pakkestoerrelse"
              value={s}
              checked={stoerrelse === s}
              onChange={() => setStoerrelse(s)}
              className="sr-only"
            />
            <span className="block font-medium text-neutral-900">{PAKKESTOERRELSE_NAVN[s]}</span>
            <span className="block text-xs text-neutral-500">{STOERRELSE_HJAELP[s]}</span>
          </label>
        ))}
      </fieldset>
      {fejl && (
        <p role="alert" className="mt-4 rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
      <button
        type="button"
        onClick={lav}
        disabled={arbejder || !stoerrelse}
        className="mt-4 rounded-lg bg-orange-knap px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-knap-mork disabled:opacity-50"
      >
        {arbejder ? "Laver label…" : "Lav fragtlabel"}
      </button>
    </div>
  );
}
