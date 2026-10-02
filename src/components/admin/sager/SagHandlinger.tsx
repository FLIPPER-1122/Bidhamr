"use client";

// Handlinger på en sag i admin: afgør, retur afleveret, genåbn, luk konto
// permanent og åbn chat med køber/sælger. Rettighederne (kan.*) kommer fra
// hentSag(), og serveren tjekker rollen igen ved hver handling.
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  aabnSagChat,
  afgoerSag,
  genaabnSag,
  lukKontoPermanent,
  registrerReturAfleveret,
} from "@/app/actions/adminSager";
import { SAG_BEGRUNDELSE_MAKS, type SagType } from "@/lib/sager";
import { STAFF_CHAT_MAKS_TEKST } from "@/lib/staffChat";

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

const FELT =
  "mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-groen sm:text-sm";

// ------------------------------------------------------------------ Dialog

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
    boksRef.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
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

function Fejl({ fejl }: { fejl: string | null }) {
  if (!fejl) return null;
  return (
    <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
      {fejl}
    </p>
  );
}

function Knapper({
  sender,
  onLuk,
  bekraeft,
  fare = false,
  deaktiveret = false,
}: {
  sender: boolean;
  onLuk: () => void;
  bekraeft: string;
  fare?: boolean;
  deaktiveret?: boolean;
}) {
  return (
    <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:justify-end">
      <button type="button" onClick={onLuk} disabled={sender} className="btn btn-sekundaer">
        Annullér
      </button>
      <button
        type="submit"
        disabled={sender || deaktiveret}
        aria-busy={sender}
        className={`btn ${fare ? "btn-fare-fyldt" : "btn-primaer"}`}
      >
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        {bekraeft}
      </button>
    </div>
  );
}

// Fælles afsendelse: lås mod dobbeltklik, vis fejl i dialogen, og giv
// resultatbeskeden videre til siden, når det lykkes.
function useSend(onResultat: (besked: string) => void, onLuk: () => void) {
  const router = useRouter();
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const laas = useRef(false);

  async function send(fn: () => Promise<{ ok: true; besked: string } | { fejl: string }>) {
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
      onLuk();
      onResultat(res.besked);
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

// ------------------------------------------------------------------ Afgør

type Udfald = "koeber" | "saelger" | "lukket";

function konsekvens(udfald: Udfald, type: SagType): string {
  if (udfald === "koeber") {
    return type === "svindel" || type === "bortkommet"
      ? "Køberen refunderes – alt undtagen BidHamr Beskyttelse – når ankefristen på 4 dage er udløbet. Indtil da kan en admin genåbne sagen."
      : "Køberen skal sende varen retur før refusion. BidHamr betaler returfragten. Sagen står som \"Afventer retur\", indtil du registrerer, at returpakken er afleveret. Køberen refunderes, når returpakken er afleveret og ankefristen på 4 dage er udløbet.";
  }
  if (udfald === "saelger") {
    return "Pengene frigives til sælgeren, når ankefristen på 4 dage er udløbet. Indtil da kan en admin genåbne sagen.";
  }
  return "Sagen lukkes uden afgørelse. Ingen penge flyttes. Frysningen fjernes efter ankefristen på 4 dage, og derefter fortsætter handlen normalt.";
}

const UDFALD_NAVN: Record<Udfald, string> = {
  koeber: "Medhold til køber",
  saelger: "Medhold til sælger",
  lukket: "Luk sag",
};

function AfgoerKnap({
  sagId,
  type,
  indsigelse,
  onResultat,
}: {
  sagId: string;
  type: SagType;
  indsigelse: boolean;
  onResultat: (b: string) => void;
}) {
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [udfald, setUdfald] = useState<Udfald | "">("");
  const luk = () => setAaben(false);
  const { sender, fejl, setFejl, send } = useSend(onResultat, luk);

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!udfald) {
      setFejl("Vælg et udfald.");
      return;
    }
    const fd = new FormData(e.currentTarget);
    fd.set("sagId", sagId);
    fd.set("udfald", udfald);
    void send(() => afgoerSag(fd));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFejl(null);
          setUdfald("");
          setAaben(true);
        }}
        className="btn btn-primaer"
      >
        Afgør sagen
      </button>
      <Dialog
        titel="Afgør sagen"
        beskrivelse="Køber og sælger får besked med din begrundelse."
        aaben={aaben}
        onLuk={luk}
        laast={sender}
      >
        <form onSubmit={indsend} className="space-y-4">
          {indsigelse && (
            <p className="rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-sm text-advarsel-tekst">
              Køberen har en åben indsigelse hos sin bank. Pengene kan ikke flyttes, før den er afgjort.
            </p>
          )}
          <fieldset>
            <legend className="text-sm font-medium text-neutral-800">Udfald</legend>
            <div className="mt-2 space-y-2">
              {(Object.keys(UDFALD_NAVN) as Udfald[]).map((u) => (
                <label
                  key={u}
                  className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${
                    udfald === u ? "border-groen bg-groen-lys" : "border-neutral-200 hover:bg-neutral-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="udfald_valg"
                    value={u}
                    checked={udfald === u}
                    onChange={() => setUdfald(u)}
                    disabled={sender}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[#1E5E4A]"
                  />
                  <span>
                    <span className="block font-semibold text-neutral-900">{UDFALD_NAVN[u]}</span>
                    <span className="block text-neutral-600">{konsekvens(u, type)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor={`${id}-begr`} className="block text-sm font-medium text-neutral-800">
              Begrundelse til køber og sælger
            </label>
            <textarea
              id={`${id}-begr`}
              name="begrundelse"
              required
              rows={4}
              maxLength={SAG_BEGRUNDELSE_MAKS}
              disabled={sender}
              aria-describedby={`${id}-begr-hj`}
              className={FELT}
            />
            <p id={`${id}-begr-hj`} className="mt-1 text-xs text-neutral-500">
              Vises for både køber og sælger. Skriv aldrig beløb eller interne oplysninger her.
            </p>
          </div>
          <div>
            <label htmlFor={`${id}-note`} className="block text-sm font-medium text-neutral-800">
              Intern note <span className="font-normal text-neutral-500">(valgfri)</span>
            </label>
            <textarea
              id={`${id}-note`}
              name="intern_note"
              rows={3}
              maxLength={4000}
              disabled={sender}
              aria-describedby={`${id}-note-hj`}
              className={FELT}
            />
            <p id={`${id}-note-hj`} className="mt-1 text-xs text-neutral-500">
              Kun synlig for BidHamr.
            </p>
          </div>
          <Fejl fejl={fejl} />
          <Knapper
            sender={sender}
            onLuk={luk}
            bekraeft={udfald ? `Bekræft: ${UDFALD_NAVN[udfald].toLowerCase()}` : "Bekræft"}
            deaktiveret={!udfald}
          />
        </form>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ Retur afleveret

function ReturKnap({ sagId, onResultat }: { sagId: string; onResultat: (b: string) => void }) {
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const luk = () => setAaben(false);
  const { sender, fejl, setFejl, send } = useSend(onResultat, luk);

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("sagId", sagId);
    void send(() => registrerReturAfleveret(fd));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFejl(null);
          setAaben(true);
        }}
        className="btn btn-primaer"
      >
        Retur afleveret
      </button>
      <Dialog
        titel="Er returpakken afleveret?"
        beskrivelse="Køberen refunderes – alt undtagen BidHamr Beskyttelse – når ankefristen på 4 dage efter afgørelsen er udløbet (straks, hvis den allerede er udløbet). Kan ikke fortrydes."
        aaben={aaben}
        onLuk={luk}
        laast={sender}
      >
        <form onSubmit={indsend} className="space-y-4">
          <div>
            <label htmlFor={`${id}-note`} className="block text-sm font-medium text-neutral-800">
              Intern note <span className="font-normal text-neutral-500">(valgfri)</span>
            </label>
            <textarea
              id={`${id}-note`}
              name="note"
              rows={3}
              maxLength={2000}
              disabled={sender}
              placeholder="Fx sporingsnummer på returpakken"
              className={FELT}
            />
          </div>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Ja, returpakken er afleveret" />
        </form>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ Genåbn

function GenaabnKnap({ sagId, onResultat }: { sagId: string; onResultat: (b: string) => void }) {
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const luk = () => setAaben(false);
  const { sender, fejl, setFejl, send } = useSend(onResultat, luk);

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("sagId", sagId);
    void send(() => genaabnSag(fd));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFejl(null);
          setAaben(true);
        }}
        className="btn btn-sekundaer"
      >
        Genåbn sagen
      </button>
      <Dialog
        titel="Genåbn sagen?"
        beskrivelse="Pengene fryses igen, og køber og sælger får besked. Inden for ankefristen annulleres den planlagte refusion eller udbetaling. Kan kun lade sig gøre, hvis ingen penge er flyttet."
        aaben={aaben}
        onLuk={luk}
        laast={sender}
      >
        <form onSubmit={indsend} className="space-y-4">
          <div>
            <label htmlFor={`${id}-aarsag`} className="block text-sm font-medium text-neutral-800">
              Hvorfor genåbnes sagen?
            </label>
            <textarea
              id={`${id}-aarsag`}
              name="aarsag"
              required
              rows={3}
              maxLength={SAG_BEGRUNDELSE_MAKS}
              disabled={sender}
              className={FELT}
            />
          </div>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Genåbn sagen" />
        </form>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ Luk konto

function LukKontoKnap({
  sagId,
  brugerId,
  rolle,
  navn,
  onResultat,
}: {
  sagId: string;
  brugerId: string;
  rolle: "køberens" | "sælgerens";
  navn: string;
  onResultat: (b: string) => void;
}) {
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [sikker, setSikker] = useState(false);
  const luk = () => setAaben(false);
  const { sender, fejl, setFejl, send } = useSend(onResultat, luk);

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sikker) return;
    const fd = new FormData(e.currentTarget);
    fd.set("sagId", sagId);
    fd.set("userId", brugerId);
    void send(() => lukKontoPermanent(fd));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFejl(null);
          setSikker(false);
          setAaben(true);
        }}
        className="btn btn-fare btn-lille"
      >
        Luk {rolle} konto permanent
      </button>
      <Dialog
        titel={`Luk kontoen for ${navn} permanent?`}
        beskrivelse="Kontoen lukkes uden slutdato og kan ikke åbnes igen fra admin. Bruges ved svindel."
        aaben={aaben}
        onLuk={luk}
        laast={sender}
      >
        <form onSubmit={indsend} className="space-y-4">
          <div>
            <label htmlFor={`${id}-aarsag`} className="block text-sm font-medium text-neutral-800">
              Årsag
            </label>
            <textarea
              id={`${id}-aarsag`}
              name="aarsag"
              required
              rows={3}
              maxLength={1000}
              disabled={sender}
              className={FELT}
            />
          </div>
          <label className="flex items-start gap-2 text-sm text-neutral-800">
            <input
              type="checkbox"
              checked={sikker}
              onChange={(e) => setSikker(e.target.checked)}
              disabled={sender}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#A32020]"
            />
            Jeg er sikker. Kontoen lukkes permanent.
          </label>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Luk kontoen permanent" fare deaktiveret={!sikker} />
        </form>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ Chat

function ChatKnap({ sagId, part, navn }: { sagId: string; part: "koeber" | "saelger"; navn: string }) {
  const router = useRouter();
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [besked, setBesked] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const laas = useRef(false);
  const luk = () => setAaben(false);

  async function indsend(e: FormEvent) {
    e.preventDefault();
    if (laas.current) return;
    laas.current = true;
    setSender(true);
    setFejl(null);
    try {
      const res = await aabnSagChat(sagId, part, besked.trim() || null);
      if ("fejl" in res) {
        setFejl(res.fejl);
        laas.current = false;
        setSender(false);
        return;
      }
      // Forbliver låst, indtil siden skifter.
      router.push(`/admin/chats/${res.samtaleId}${res.fandtes ? "?fandtes=1" : ""}`);
    } catch {
      setFejl(GENERISK);
      laas.current = false;
      setSender(false);
    }
  }

  const hvem = part === "koeber" ? "køber" : "sælger";
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFejl(null);
          setAaben(true);
        }}
        className="btn btn-sekundaer btn-lille"
      >
        Åbn chat med {hvem}
      </button>
      <Dialog
        titel={`Åbn chat med ${hvem} (${navn})`}
        beskrivelse="Samtalen knyttes til sagen. Findes der allerede en åben chat, bruges den."
        aaben={aaben}
        onLuk={luk}
        laast={sender}
      >
        <form onSubmit={indsend} className="space-y-4">
          <div>
            <label htmlFor={`${id}-besked`} className="block text-sm font-medium text-neutral-800">
              Første besked <span className="font-normal text-neutral-500">(valgfri)</span>
            </label>
            <textarea
              id={`${id}-besked`}
              value={besked}
              onChange={(e) => setBesked(e.target.value)}
              rows={4}
              maxLength={STAFF_CHAT_MAKS_TEKST}
              disabled={sender}
              className={FELT}
            />
          </div>
          <Fejl fejl={fejl} />
          <Knapper sender={sender} onLuk={luk} bekraeft="Åbn chat" />
        </form>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------------ Samlet

export type SagHandlingerProps = {
  sagId: string;
  type: SagType;
  indsigelse: boolean;
  kan: { afgoere: boolean; registrereRetur: boolean; genaabne: boolean; lukkeKonto: boolean };
  koeber: { id: string; navn: string; lukket: boolean };
  saelger: { id: string; navn: string; lukket: boolean };
};

export default function SagHandlinger({ sagId, type, indsigelse, kan, koeber, saelger }: SagHandlingerProps) {
  const [resultat, setResultat] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {resultat && (
        <p role="status" className="rounded-lg border border-succes-kant bg-succes-bg px-4 py-3 text-sm text-succes-tekst">
          {resultat}
        </p>
      )}

      {(kan.afgoere || kan.registrereRetur || kan.genaabne) && (
        <div className="flex flex-wrap gap-3">
          {kan.afgoere && (
            <AfgoerKnap sagId={sagId} type={type} indsigelse={indsigelse} onResultat={setResultat} />
          )}
          {kan.registrereRetur && <ReturKnap sagId={sagId} onResultat={setResultat} />}
          {kan.genaabne && <GenaabnKnap sagId={sagId} onResultat={setResultat} />}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {koeber.id && <ChatKnap sagId={sagId} part="koeber" navn={koeber.navn} />}
        {saelger.id && <ChatKnap sagId={sagId} part="saelger" navn={saelger.navn} />}
      </div>

      {kan.lukkeKonto && (
        <div className="flex flex-wrap gap-2 border-t border-neutral-100 pt-4">
          {koeber.lukket ? (
            <span className="text-sm text-neutral-500">Køberens konto er lukket permanent.</span>
          ) : (
            koeber.id && (
              <LukKontoKnap sagId={sagId} brugerId={koeber.id} rolle="køberens" navn={koeber.navn} onResultat={setResultat} />
            )
          )}
          {saelger.lukket ? (
            <span className="text-sm text-neutral-500">Sælgerens konto er lukket permanent.</span>
          ) : (
            saelger.id && (
              <LukKontoKnap sagId={sagId} brugerId={saelger.id} rolle="sælgerens" navn={saelger.navn} onResultat={setResultat} />
            )
          )}
        </div>
      )}
    </div>
  );
}
