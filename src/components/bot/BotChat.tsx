"use client";

// BidHamr-bot: den flydende knap og chatvinduet. Svaret streames fra
// POST /api/bot (NDJSON, src/lib/bot/motor.ts). Samtalen huskes i
// sessionStorage, så den overlever et sideskift i samme fane.
//
// - Øverst står tydeligt, at man skriver med en AI (AI-forordningen art. 50).
// - Under chatten: svarene er vejledende - reglerne og handelsbetingelserne gælder.
// - Efter brugerens første besked vises "Kontakt en rigtig medarbejder".
//   Botten kan selv fremhæve knappen (type "medarbejder" i strømmen).
// - Uden login skal e-mailen angives, før samtalen sendes videre.
// Al tekst vises som ren tekst (ingen HTML), så et svar aldrig kan indsætte kode.

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

type Besked = { rolle: "bruger" | "bot"; tekst: string };
type Gemt = { samtaleId: string | null; beskeder: Besked[]; overdraget: boolean; loggetInd: boolean };

const NOEGLE = "bidhamr-bot-samtale";
const VELKOMST =
  "Hej! Jeg er BidHamr-bot. Jeg kan svare på spørgsmål om bud, betaling, gebyrer, fragt og BidHamr Beskyttelse.";
const GENERISK = "Noget gik galt. Prøv igen om lidt.";

function laesGemt(loggetInd: boolean): Gemt | null {
  try {
    const raa = window.sessionStorage.getItem(NOEGLE);
    if (!raa) return null;
    const g = JSON.parse(raa) as Gemt;
    // Logget ind eller ud siden: start forfra (samtalen tilhører den anden).
    if (g.loggetInd !== loggetInd || !Array.isArray(g.beskeder)) return null;
    return g;
  } catch {
    return null;
  }
}

function gem(g: Gemt) {
  try {
    window.sessionStorage.setItem(NOEGLE, JSON.stringify(g));
  } catch {
    // Samtalen huskes så bare ikke.
  }
}

function BotIkon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M8 9h8" />
      <path d="M8 13h6" />
      <path d="M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z" />
    </svg>
  );
}

export default function BotChat({ loggetInd, maksTegn }: { loggetInd: boolean; maksTegn: number }) {
  const [aaben, setAaben] = useState(false);
  const [beskeder, setBeskeder] = useState<Besked[]>([]);
  const [samtaleId, setSamtaleId] = useState<string | null>(null);
  const [tekst, setTekst] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [nySamtale, setNySamtale] = useState(false);
  const [fremhaev, setFremhaev] = useState(false);
  const [visEmail, setVisEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [overdrager, setOverdrager] = useState(false);
  const [overdraget, setOverdraget] = useState(false);
  const [overdragFejl, setOverdragFejl] = useState<string | null>(null);
  const indlaest = useRef(false);
  const listeRef = useRef<HTMLDivElement>(null);
  const feltRef = useRef<HTMLTextAreaElement>(null);
  const knapRef = useRef<HTMLButtonElement>(null);
  const titelId = useId();
  const feltId = useId();

  // Hent samtalen fra sessionStorage første gang, vinduet åbnes.
  useEffect(() => {
    if (!aaben || indlaest.current) return;
    indlaest.current = true;
    const g = laesGemt(loggetInd);
    if (g) {
      /* eslint-disable react-hooks/set-state-in-effect -- engangsindlæsning fra sessionStorage */
      setBeskeder(g.beskeder);
      setSamtaleId(g.samtaleId);
      setOverdraget(g.overdraget);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [aaben, loggetInd]);

  useEffect(() => {
    if (!indlaest.current) return;
    gem({ samtaleId, beskeder, overdraget, loggetInd });
  }, [samtaleId, beskeder, overdraget, loggetInd]);

  useEffect(() => {
    listeRef.current?.scrollTo({ top: listeRef.current.scrollHeight });
  }, [beskeder, aaben]);

  useEffect(() => {
    if (aaben) requestAnimationFrame(() => feltRef.current?.focus());
  }, [aaben]);

  const luk = useCallback(() => {
    setAaben(false);
    requestAnimationFrame(() => knapRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!aaben) return;
    const tast = (e: KeyboardEvent) => {
      if (e.key === "Escape") luk();
    };
    window.addEventListener("keydown", tast);
    return () => window.removeEventListener("keydown", tast);
  }, [aaben, luk]);

  const startForfra = () => {
    setBeskeder([]);
    setSamtaleId(null);
    setOverdraget(false);
    setFremhaev(false);
    setVisEmail(false);
    setNySamtale(false);
    setFejl(null);
    setOverdragFejl(null);
  };

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const besked = tekst.trim();
    if (!besked || sender) return;
    if (besked.length > maksTegn) {
      setFejl(`Beskeden må højst være ${maksTegn.toLocaleString("da-DK")} tegn.`);
      return;
    }
    setFejl(null);
    setSender(true);
    setTekst("");
    setBeskeder((b) => [...b, { rolle: "bruger", tekst: besked }, { rolle: "bot", tekst: "" }]);

    const tilfoej = (stykke: string) =>
      setBeskeder((b) => {
        const kopi = b.slice();
        const sidste = kopi[kopi.length - 1];
        kopi[kopi.length - 1] = { rolle: "bot", tekst: sidste.tekst + stykke };
        return kopi;
      });

    try {
      const res = await fetch("/api/bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ samtaleId, besked }),
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { fejl?: string; kode?: string } | null;
        setBeskeder((b) => b.slice(0, -1));
        setFejl(j?.fejl ?? GENERISK);
        if (j?.kode === "ukendt_samtale" || j?.kode === "samtale_fuld") setNySamtale(true);
        if (j?.kode === "loft_bruger" || j?.kode === "loft_ip" || j?.kode === "loft_alle") setFremhaev(true);
        return;
      }
      const laeser = res.body.getReader();
      const dekoder = new TextDecoder();
      let rest = "";
      for (;;) {
        const { done, value } = await laeser.read();
        if (done) break;
        rest += dekoder.decode(value, { stream: true });
        const linjer = rest.split("\n");
        rest = linjer.pop() ?? "";
        for (const linje of linjer) {
          if (!linje.trim()) continue;
          let h: { type?: string; tekst?: string; samtaleId?: string; fejl?: string };
          try {
            h = JSON.parse(linje);
          } catch {
            continue;
          }
          if (h.type === "samtale" && typeof h.samtaleId === "string") setSamtaleId(h.samtaleId);
          else if (h.type === "tekst" && typeof h.tekst === "string") tilfoej(h.tekst);
          else if (h.type === "medarbejder") setFremhaev(true);
          else if (h.type === "fejl") setFejl(typeof h.fejl === "string" ? h.fejl : GENERISK);
        }
      }
    } catch {
      setFejl(GENERISK);
    } finally {
      // Et tomt svar (fx afbrudt forbindelse) fjernes igen.
      setBeskeder((b) => (b.length && b[b.length - 1].rolle === "bot" && !b[b.length - 1].tekst ? b.slice(0, -1) : b));
      setSender(false);
      requestAnimationFrame(() => feltRef.current?.focus());
    }
  }

  async function kontaktMedarbejder(e?: React.FormEvent) {
    e?.preventDefault();
    if (!samtaleId || overdrager || overdraget) return;
    if (!loggetInd && !visEmail) {
      setVisEmail(true);
      return;
    }
    setOverdragFejl(null);
    setOverdrager(true);
    try {
      const res = await fetch("/api/bot/medarbejder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ samtaleId, ...(loggetInd ? {} : { email: email.trim() }) }),
      });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; fejl?: string } | null;
      if (res.ok && j?.ok) {
        setOverdraget(true);
        setVisEmail(false);
      } else {
        setOverdragFejl(j?.fejl ?? GENERISK);
      }
    } catch {
      setOverdragFejl(GENERISK);
    } finally {
      setOverdrager(false);
    }
  }

  const harSkrevet = beskeder.some((b) => b.rolle === "bruger") && !!samtaleId;

  return (
    <>
      {!aaben && (
        <button
          ref={knapRef}
          type="button"
          onClick={() => setAaben(true)}
          aria-haspopup="dialog"
          className="fixed left-3 z-30 inline-flex h-12 items-center gap-2 rounded-full bg-groen pl-4 pr-5 text-sm font-semibold text-white shadow-[var(--shadow-flyder)] transition-colors hover:bg-groen-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen bottom-[calc(var(--samtykke-hoejde,0px)+env(safe-area-inset-bottom,0px)+88px)] lg:left-6 lg:bottom-[calc(var(--samtykke-hoejde,0px)+24px)] print:hidden"
        >
          <BotIkon className="h-5 w-5" />
          Spørg BidHamr-bot
        </button>
      )}

      {aaben && (
        <section
          role="dialog"
          aria-modal="false"
          aria-labelledby={titelId}
          className="fixed inset-x-0 bottom-0 z-40 flex max-h-[85svh] flex-col border border-kant bg-white shadow-[var(--shadow-stor)] sm:inset-x-auto sm:left-6 sm:bottom-6 sm:h-[600px] sm:max-h-[calc(100svh-48px)] sm:w-[400px] print:hidden"
        >
          <header className="flex items-start justify-between gap-3 bg-groen px-4 py-3 text-white">
            <div className="min-w-0">
              <h2 id={titelId} className="text-base font-semibold">
                BidHamr-bot
              </h2>
              <p className="text-xs text-white/90">Du skriver med en AI – ikke et menneske.</p>
            </div>
            <button
              type="button"
              onClick={luk}
              aria-label="Luk BidHamr-bot"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center transition-colors hover:bg-groen-mork focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" focusable="false">
                <path d="M18 6l-12 12" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </header>

          <div ref={listeRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite" aria-busy={sender}>
            <p className="max-w-[85%] whitespace-pre-wrap break-words bg-groen-lys px-3 py-2 text-sm text-tekst">
              {VELKOMST}
              {!loggetInd && " Log ind, hvis du vil have hjælp til dine egne handler, auktioner og bud."}
            </p>
            {beskeder.map((b, i) =>
              b.rolle === "bruger" ? (
                <p key={i} className="ml-auto max-w-[85%] whitespace-pre-wrap break-words bg-groen px-3 py-2 text-sm text-white">
                  <span className="sr-only">Dig: </span>
                  {b.tekst}
                </p>
              ) : (
                <p key={i} className="max-w-[85%] whitespace-pre-wrap break-words bg-groen-lys px-3 py-2 text-sm text-tekst">
                  <span className="sr-only">BidHamr-bot: </span>
                  {b.tekst || (sender && i === beskeder.length - 1 ? "Skriver …" : "")}
                </p>
              ),
            )}
            {fejl && (
              <p role="alert" className="border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
                {fejl}
                {nySamtale && (
                  <>
                    {" "}
                    <button type="button" onClick={startForfra} className="font-semibold underline">
                      Start en ny samtale
                    </button>
                  </>
                )}
              </p>
            )}
          </div>

          {harSkrevet && (
            <div className={`border-t border-kant px-4 py-3 ${fremhaev && !overdraget ? "bg-advarsel-bg" : ""}`}>
              {overdraget ? (
                <p role="status" className="text-sm text-succes-tekst">
                  Tak. Samtalen er sendt til en medarbejder, som svarer dig{" "}
                  {loggetInd ? (
                    <>
                      i <Link href="/beskeder" className="font-semibold underline">Beskeder</Link> under &quot;Fra BidHamr&quot;.
                    </>
                  ) : (
                    "på mail."
                  )}
                </p>
              ) : visEmail ? (
                <form onSubmit={kontaktMedarbejder} className="space-y-2">
                  <label htmlFor={`${feltId}-email`} className="block text-sm font-medium text-tekst">
                    Din e-mail, så medarbejderen kan svare dig
                  </label>
                  <div className="flex gap-2">
                    <input
                      id={`${feltId}-email`}
                      type="email"
                      required
                      autoComplete="email"
                      maxLength={254}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="h-11 min-w-0 flex-1 border border-kant-staerk px-3 text-sm"
                    />
                    <button type="submit" disabled={overdrager} className="btn btn-sekundaer btn-lille">
                      {overdrager ? "Sender …" : "Send"}
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => kontaktMedarbejder()}
                  disabled={overdrager || sender}
                  className="btn btn-sekundaer btn-lille w-full"
                >
                  {overdrager ? "Sender …" : "Kontakt en rigtig medarbejder"}
                </button>
              )}
              {overdragFejl && (
                <p role="alert" className="mt-2 text-sm text-fejl-tekst">
                  {overdragFejl}
                </p>
              )}
            </div>
          )}

          <form onSubmit={send} className="border-t border-kant px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
            <label htmlFor={feltId} className="sr-only">
              Skriv til BidHamr-bot
            </label>
            <div className="flex items-end gap-2">
              <textarea
                id={feltId}
                ref={feltRef}
                rows={2}
                maxLength={maksTegn}
                value={tekst}
                onChange={(e) => setTekst(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Skriv dit spørgsmål …"
                className="min-h-11 flex-1 resize-none border border-kant-staerk px-3 py-2 text-sm"
              />
              <button type="submit" disabled={sender || !tekst.trim()} className="btn btn-primaer btn-lille">
                Send
              </button>
            </div>
            <p className="mt-2 text-xs text-tekst-svag">
              Svarene er vejledende. Det er BidHamrs regler og{" "}
              <Link href="/betingelser" className="underline">
                handelsbetingelser
              </Link>
              , der gælder. Skriv ikke adgangskoder eller kortoplysninger.
            </p>
          </form>
        </section>
      )}
    </>
  );
}
