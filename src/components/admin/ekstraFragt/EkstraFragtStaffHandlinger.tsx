"use client";

// Staffs knapper på en regning for ekstra fragt: åbn fragtfirmaets
// dokumentation, frafald (grund vises for sælgeren), afgør sælgerens
// indsigelse (frafald/fasthold + begrundelse, som sælgeren ser) og den
// interne note. Ingen dialoger: hver knap folder en kort formular ud på
// stedet (færrest klik, virker på mobil). Databasen tjekker rolle,
// to-trins-login og inhabilitet igen (src/app/actions/adminEkstraFragt.ts).
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import {
  afgoerEkstraFragtIndsigelse,
  frafaldEkstraFragt,
  gemEkstraFragtNote,
  hentEkstraFragtDokumentationStaff,
  type EkstraFragtStaffSvar,
} from "@/app/actions/adminEkstraFragt";
import { visKvittering } from "@/components/admin/Kvittering";
import type { EkstraFragtStatus } from "@/lib/ekstraFragt/tekster";
import { useHydreret } from "@/lib/useHydreret";

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const FELT =
  "mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-groen sm:text-sm";

function useSend() {
  const router = useRouter();
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const laas = useRef(false);
  async function send(fn: () => Promise<EkstraFragtStaffSvar>, kvittering: string, efter?: () => void) {
    if (laas.current) return;
    laas.current = true;
    setSender(true);
    setFejl(null);
    try {
      const res = await fn();
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      efter?.();
      visKvittering(res.uaendret ? "Intet at ændre." : kvittering);
      router.refresh();
    } catch {
      setFejl(GENERISK);
    } finally {
      laas.current = false;
      setSender(false);
    }
  }
  return { sender, fejl, setFejl, send };
}

function Fejl({ fejl }: { fejl: string | null }) {
  if (!fejl) return null;
  return (
    <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
      {fejl}
    </p>
  );
}

export function EkstraFragtDokumentationKnap({ regningId }: { regningId: string }) {
  const [henter, setHenter] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  async function hent() {
    if (henter) return;
    setHenter(true);
    setFejl(null);
    try {
      const res = await hentEkstraFragtDokumentationStaff(regningId);
      if ("fejl" in res) setFejl(res.fejl);
      else window.location.assign(res.url);
    } catch {
      setFejl(GENERISK);
    } finally {
      setHenter(false);
    }
  }
  return (
    <span className="flex flex-col gap-1">
      <button type="button" onClick={hent} disabled={henter} aria-busy={henter || undefined} className="btn btn-sekundaer w-full sm:w-auto">
        {henter && <span className="btn-spinner" aria-hidden="true" />}
        Hent fragtfirmaets faktura
      </button>
      <Fejl fejl={fejl} />
    </span>
  );
}

function Frafald({ regningId, underIndsigelse, onLuk }: { regningId: string; underIndsigelse: boolean; onLuk: () => void }) {
  const id = useId();
  const { sender, fejl, setFejl, send } = useSend();
  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const grund = String(new FormData(e.currentTarget).get("grund") ?? "").trim();
    if (!grund) return setFejl("Skriv en begrundelse. Den vises for sælgeren.");
    void send(() => frafaldEkstraFragt(regningId, grund), "Regningen er frafaldet. Sælgeren får besked.", onLuk);
  }
  return (
    <form onSubmit={indsend} method="post" className="space-y-3 rounded-lg border border-admin-kant p-4">
      <p className="text-sm text-tekst-daempet">
        Sælgeren skal ikke betale. {underIndsigelse ? "Indsigelsen afgøres samtidig til sælgerens fordel. " : ""}
        En åben betaling annulleres.
      </p>
      <div>
        <label htmlFor={`${id}-grund`} className="block text-sm font-medium text-tekst">
          Begrundelse til sælgeren
        </label>
        <textarea
          id={`${id}-grund`}
          name="grund"
          rows={3}
          required
          maxLength={1000}
          disabled={sender}
          autoFocus
          placeholder="Fx: Vi har tjekket målingen igen, og pakken var inden for den valgte størrelse."
          className={FELT}
        />
      </div>
      <Fejl fejl={fejl} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="submit" disabled={sender} aria-busy={sender || undefined} className="btn btn-fare-fyldt w-full sm:w-auto">
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Frafald regningen
        </button>
        <button type="button" onClick={onLuk} disabled={sender} className="btn btn-sekundaer w-full sm:w-auto">
          Annullér
        </button>
      </div>
    </form>
  );
}

function Afgoer({ regningId, onLuk }: { regningId: string; onLuk: () => void }) {
  const id = useId();
  const [udfald, setUdfald] = useState<"frafald" | "fasthold" | null>(null);
  const { sender, fejl, setFejl, send } = useSend();
  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const begrundelse = String(new FormData(e.currentTarget).get("begrundelse") ?? "").trim();
    if (!udfald) return setFejl("Vælg frafald eller fasthold.");
    if (!begrundelse) return setFejl("Skriv en begrundelse. Den vises for sælgeren.");
    void send(
      () => afgoerEkstraFragtIndsigelse(regningId, udfald, begrundelse),
      udfald === "frafald" ? "Indsigelsen er afgjort: regningen er frafaldet." : "Indsigelsen er afgjort: regningen er fastholdt.",
      onLuk,
    );
  }
  return (
    <form onSubmit={indsend} method="post" className="space-y-3 rounded-lg border border-admin-kant p-4">
      <fieldset>
        <legend className="text-sm font-medium text-tekst">Afgørelse</legend>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(
            [
              ["frafald", "Frafald – sælgeren har ret", "Sælgeren skal ikke betale."],
              ["fasthold", "Fasthold regningen", "Sælgeren har mindst 7 dage til at betale."],
            ] as const
          ).map(([v, titel, tekst]) => (
            <label
              key={v}
              className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm ${
                udfald === v ? "border-groen bg-groen-lys" : "border-admin-kant"
              }`}
            >
              <input
                type="radio"
                name="udfald"
                value={v}
                checked={udfald === v}
                onChange={() => setUdfald(v)}
                disabled={sender}
                className="mt-0.5 h-5 w-5 shrink-0 accent-groen"
              />
              <span>
                <span className="block font-semibold text-tekst">{titel}</span>
                <span className="block text-tekst-daempet">{tekst}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor={`${id}-beg`} className="block text-sm font-medium text-tekst">
          Begrundelse til sælgeren
        </label>
        <textarea
          id={`${id}-beg`}
          name="begrundelse"
          rows={3}
          required
          maxLength={1000}
          disabled={sender}
          placeholder="Fx: Fragtfirmaets måling viser 7,2 kg, og pakken var registreret som Mellem (op til 5 kg)."
          className={FELT}
        />
      </div>
      <Fejl fejl={fejl} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="submit" disabled={sender} aria-busy={sender || undefined} className="btn btn-primaer w-full sm:w-auto">
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Afgør indsigelsen
        </button>
        <button type="button" onClick={onLuk} disabled={sender} className="btn btn-sekundaer w-full sm:w-auto">
          Annullér
        </button>
      </div>
    </form>
  );
}

export function EkstraFragtNote({ regningId, note }: { regningId: string; note: string | null }) {
  const id = useId();
  const hydreret = useHydreret();
  const [tekst, setTekst] = useState(note ?? "");
  const { sender, fejl, send } = useSend();
  const aendret = tekst.trim() !== (note ?? "").trim();
  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send(() => gemEkstraFragtNote(regningId, tekst), "Noten er gemt");
  }
  return (
    <form onSubmit={indsend} method="post" className="space-y-3">
      <label htmlFor={`${id}-note`} className="sr-only">
        Intern note
      </label>
      <textarea
        id={`${id}-note`}
        value={tekst}
        onChange={(e) => setTekst(e.target.value)}
        rows={4}
        maxLength={4000}
        disabled={sender}
        placeholder="Fx: Ringede til DAO 4. nov. – målingen er bekræftet."
        className={FELT}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-tekst-svag">Kun synlig for BidHamr – aldrig for sælgeren.</p>
        <button type="submit" disabled={sender || !aendret || !hydreret} aria-busy={sender || undefined} className="btn btn-sekundaer btn-lille">
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Gem note
        </button>
      </div>
      <Fejl fejl={fejl} />
    </form>
  );
}

export default function EkstraFragtStaffHandlinger({
  regningId,
  status,
  inhabil,
}: {
  regningId: string;
  status: EkstraFragtStatus;
  inhabil: boolean;
}) {
  const [aaben, setAaben] = useState<"frafald" | "afgoer" | null>(null);
  if (inhabil) {
    return (
      <p className="rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-sm text-advarsel-tekst">
        Du er inhabil: du er part i handlen eller har handlet med en af parterne. Lad en kollega tage den.
      </p>
    );
  }
  const kanFrafalde = status === "afventer_betaling" || status === "indsigelse";
  const kanAfgoere = status === "indsigelse";
  // TODO(betaling): "Genåbn regning" efter en tabt bankindsigelse - knappen
  // kommer her, når genaabnEkstraFragt(id, begrundelse) findes i
  // src/app/actions/adminEkstraFragt.ts (betaling-agenten tilføjer den).
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
        <EkstraFragtDokumentationKnap regningId={regningId} />
        {kanAfgoere && aaben !== "afgoer" && (
          <button type="button" onClick={() => setAaben("afgoer")} className="btn btn-primaer w-full sm:w-auto">
            Afgør indsigelse
          </button>
        )}
        {kanFrafalde && aaben !== "frafald" && (
          <button type="button" onClick={() => setAaben("frafald")} className="btn btn-fare w-full sm:w-auto">
            Frafald
          </button>
        )}
      </div>
      {aaben === "afgoer" && kanAfgoere && <Afgoer regningId={regningId} onLuk={() => setAaben(null)} />}
      {aaben === "frafald" && kanFrafalde && (
        <Frafald regningId={regningId} underIndsigelse={status === "indsigelse"} onLuk={() => setAaben(null)} />
      )}
    </div>
  );
}
