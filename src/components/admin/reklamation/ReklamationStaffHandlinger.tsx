"use client";

// Staffs knapper på en reklamation: send oplysningerne igen, ret status
// (påkrævet intern begrundelse), annullér (grund til sælgeren) og den
// interne note. Databasen tjekker rolle, to-trins-login og inhabilitet igen
// (src/app/actions/adminReklamation.ts).
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  annullerReklamation,
  gemReklamationNote,
  retReklamationStatus,
  sendReklamationIgen,
  type ReklamationSvar,
} from "@/app/actions/adminReklamation";
import { visKvittering } from "@/components/admin/Kvittering";
import {
  REKLAMATION_RET_STATUSSER,
  REKLAMATION_STATUS_STAFF,
  kroner,
  type ReklamationRetStatus,
  type ReklamationStatus,
} from "@/lib/reklamation/typer";
import { useHydreret } from "@/lib/useHydreret";

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const FELT =
  "mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-groen sm:text-sm";

function useSend() {
  const router = useRouter();
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const laas = useRef(false);
  async function send(fn: () => Promise<ReklamationSvar>, kvittering: string, efter?: () => void) {
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

function Dialog({
  titel,
  beskrivelse,
  aaben,
  onLuk,
  laast,
  children,
}: {
  titel: string;
  beskrivelse?: ReactNode;
  aaben: boolean;
  onLuk: () => void;
  laast: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const boksRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aaben) return;
    const forrige = document.activeElement as HTMLElement | null;
    boksRef.current?.querySelector<HTMLElement>("select, input, textarea, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !laast) onLuk();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      forrige?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aaben]);
  if (!aaben) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={() => !laast && onLuk()}
    >
      <div
        ref={boksRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-titel`}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={`${id}-titel`} className="text-lg font-bold text-neutral-900">
          {titel}
        </h2>
        {beskrivelse && <div className="mt-1.5 text-sm text-neutral-600">{beskrivelse}</div>}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function Knapper({ sender, onLuk, bekraeft, fare = false }: { sender: boolean; onLuk: () => void; bekraeft: string; fare?: boolean }) {
  const hydreret = useHydreret();
  return (
    <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:justify-end">
      <button
        type="submit"
        disabled={sender || !hydreret}
        aria-busy={sender}
        className={`btn order-1 sm:order-2 ${fare ? "btn-fare-fyldt" : "btn-primaer"}`}
      >
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        {bekraeft}
      </button>
      <button type="button" onClick={onLuk} disabled={sender} className="btn btn-sekundaer order-2 sm:order-1">
        Annullér
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ Send igen

function SendIgenKnap({ reklamationId, sagId }: { reklamationId: string; sagId: string }) {
  const { sender, fejl, send } = useSend();
  return (
    <span className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => void send(() => sendReklamationIgen(reklamationId, sagId), "Oplysningerne er sendt til sælgeren igen")}
        disabled={sender}
        aria-busy={sender}
        className="btn btn-primaer w-full sm:w-auto"
      >
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        Send oplysninger igen
      </button>
      <Fejl fejl={fejl} />
    </span>
  );
}

// ------------------------------------------------------------------ Ret status

function RetStatusKnap({
  reklamationId,
  sagId,
  status,
  kravbeloebOere,
  sagsnummer,
}: {
  reklamationId: string;
  sagId: string;
  status: ReklamationStatus;
  kravbeloebOere: number;
  sagsnummer: string | null;
}) {
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const standard: ReklamationRetStatus = (REKLAMATION_RET_STATUSSER as readonly string[]).includes(status)
    ? (status as ReklamationRetStatus)
    : "afventer_saelger";
  const [ny, setNy] = useState<ReklamationRetStatus>(standard);
  const luk = () => setAaben(false);
  const { sender, fejl, setFejl, send } = useSend();

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const v = (k: string) => String(fd.get(k) ?? "").trim();
    if (!v("begrundelse")) {
      setFejl("Skriv en intern begrundelse for rettelsen.");
      return;
    }
    if (ny === "godkendt" && !v("beloeb")) {
      setFejl("Skriv det godkendte beløb i kroner, fx 1.250,00.");
      return;
    }
    void send(
      () =>
        retReklamationStatus({
          reklamationId,
          status: ny,
          beloebKr: v("beloeb"),
          sagsnummer: v("sagsnummer"),
          grund: v("grund"),
          begrundelse: v("begrundelse"),
          sagId,
        }),
      "Status er rettet",
      luk,
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFejl(null);
          setNy(standard);
          setAaben(true);
        }}
        className="btn btn-sekundaer w-full sm:w-auto"
      >
        Ret status
      </button>
      <Dialog
        titel="Ret reklamationens status"
        beskrivelse="Brug det, hvis sælgeren har registreret forkert, eller hvis du har fået svaret fra fragtfirmaet på anden vis. Sælgeren får ingen besked."
        aaben={aaben}
        onLuk={luk}
        laast={sender}
      >
        <form onSubmit={indsend} method="post" className="space-y-4">
          <div>
            <label htmlFor={`${id}-status`} className="block text-sm font-medium text-neutral-800">
              Ny status
            </label>
            <select
              id={`${id}-status`}
              name="status"
              value={ny}
              onChange={(e) => setNy(e.target.value as ReklamationRetStatus)}
              disabled={sender}
              className={`${FELT} h-11 bg-white`}
            >
              {REKLAMATION_RET_STATUSSER.map((s) => (
                <option key={s} value={s}>
                  {REKLAMATION_STATUS_STAFF[s]}
                </option>
              ))}
            </select>
          </div>
          {ny === "godkendt" && (
            <div>
              <label htmlFor={`${id}-beloeb`} className="block text-sm font-medium text-neutral-800">
                Godkendt beløb i kr.
              </label>
              <input id={`${id}-beloeb`} name="beloeb" inputMode="decimal" autoComplete="off" required placeholder="Fx 1.250,00" disabled={sender} className={FELT} />
              <p className="mt-1 text-xs text-neutral-500">Højst {kroner(kravbeloebOere)} (kravbeløbet).</p>
            </div>
          )}
          {(ny === "anmeldt" || ny === "godkendt" || ny === "afvist") && (
            <div>
              <label htmlFor={`${id}-nr`} className="block text-sm font-medium text-neutral-800">
                Fragtfirmaets sagsnummer <span className="font-normal text-neutral-500">(valgfrit)</span>
              </label>
              <input id={`${id}-nr`} name="sagsnummer" defaultValue={sagsnummer ?? ""} maxLength={100} autoComplete="off" disabled={sender} className={FELT} />
            </div>
          )}
          {ny === "afvist" && (
            <div>
              <label htmlFor={`${id}-grund`} className="block text-sm font-medium text-neutral-800">
                Fragtfirmaets begrundelse <span className="font-normal text-neutral-500">(valgfri – vises for sælgeren)</span>
              </label>
              <textarea id={`${id}-grund`} name="grund" rows={2} maxLength={1000} disabled={sender} className={FELT} />
            </div>
          )}
          <div>
            <label htmlFor={`${id}-beg`} className="block text-sm font-medium text-neutral-800">
              Intern begrundelse
            </label>
            <textarea
              id={`${id}-beg`}
              name="begrundelse"
              rows={3}
              required
              maxLength={2000}
              disabled={sender}
              placeholder="Fx: Sælgeren skrev i chatten, at DAO har godkendt 1.200 kr."
              className={FELT}
            />
            <p className="mt-1 text-xs text-neutral-500">Kun synlig for BidHamr. Gemmes i loggen.</p>
          </div>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Ret status" />
        </form>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ Annullér

function AnnullerKnap({ reklamationId, sagId }: { reklamationId: string; sagId: string }) {
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const luk = () => setAaben(false);
  const { sender, fejl, setFejl, send } = useSend();

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const grund = String(new FormData(e.currentTarget).get("grund") ?? "").trim();
    if (!grund) {
      setFejl("Skriv en begrundelse. Den vises for sælgeren.");
      return;
    }
    void send(() => annullerReklamation(reklamationId, grund, sagId), "Reklamationen er annulleret", luk);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFejl(null);
          setAaben(true);
        }}
        className="btn btn-fare w-full sm:w-auto"
      >
        Annullér
      </button>
      <Dialog
        titel="Annullér reklamationen"
        beskrivelse="Sælgeren kan så ikke længere hente oplysningerne og får en besked med din begrundelse."
        aaben={aaben}
        onLuk={luk}
        laast={sender}
      >
        <form onSubmit={indsend} method="post" className="space-y-4">
          <div>
            <label htmlFor={`${id}-grund`} className="block text-sm font-medium text-neutral-800">
              Begrundelse til sælgeren
            </label>
            <textarea
              id={`${id}-grund`}
              name="grund"
              rows={3}
              required
              maxLength={1000}
              disabled={sender}
              placeholder="Fx: Skaden skyldes ikke fragten, så der kan ikke reklameres."
              className={FELT}
            />
          </div>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Annullér reklamationen" fare />
        </form>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ Note

export function ReklamationNote({
  reklamationId,
  sagId,
  note,
  inhabil,
}: {
  reklamationId: string;
  sagId: string;
  note: string | null;
  inhabil: boolean;
}) {
  const id = useId();
  const hydreret = useHydreret();
  const [tekst, setTekst] = useState(note ?? "");
  const { sender, fejl, send } = useSend();
  const aendret = tekst.trim() !== (note ?? "").trim();

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send(() => gemReklamationNote(reklamationId, tekst, sagId), "Noten er gemt");
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
        disabled={sender || inhabil}
        placeholder="Fx: Ringede til sælgeren 3. nov. – anmelder i weekenden."
        className={FELT}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">Kun synlig for BidHamr – aldrig for sælgeren.</p>
        <button type="submit" disabled={sender || !aendret || inhabil || !hydreret} aria-busy={sender} className="btn btn-sekundaer btn-lille">
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Gem note
        </button>
      </div>
      <Fejl fejl={fejl} />
    </form>
  );
}

// ------------------------------------------------------------------ Samlet

export default function ReklamationStaffHandlinger({
  reklamationId,
  sagId,
  status,
  kravbeloebOere,
  sagsnummer,
  inhabil,
}: {
  reklamationId: string;
  sagId: string;
  status: ReklamationStatus;
  kravbeloebOere: number;
  sagsnummer: string | null;
  inhabil: boolean;
}) {
  if (inhabil) {
    return (
      <p className="rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-sm text-advarsel-tekst">
        Du er inhabil: du er part i handlen eller har handlet med en af parterne. Lad en kollega tage den.
      </p>
    );
  }
  const aaben = status === "afventer_saelger" || status === "anmeldt";
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
      {aaben && <SendIgenKnap reklamationId={reklamationId} sagId={sagId} />}
      <RetStatusKnap reklamationId={reklamationId} sagId={sagId} status={status} kravbeloebOere={kravbeloebOere} sagsnummer={sagsnummer} />
      {aaben && <AnnullerKnap reklamationId={reklamationId} sagId={sagId} />}
    </div>
  );
}
