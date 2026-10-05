"use client";

// "Fællesbesked til køber og sælger" (kun admin og chef - serveren tjekker
// rollen igen). Beskeden lægges i handlens chat, markeret som fra BidHamr.
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { sendFaellesbesked } from "@/app/actions/staffChat";
import { FAELLESBESKED_MAKS_TEKST } from "@/lib/staffChat";

export default function FaellesbeskedKnap({ tradeId }: { tradeId: string }) {
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [tekst, setTekst] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);
  const feltRef = useRef<HTMLTextAreaElement>(null);
  const senderLaas = useRef(false);
  const knapRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const varAaben = useRef(false);

  // Fokus tilbage til knappen, når dialogen lukkes (Esc, Annullér, sendt).
  useEffect(() => {
    if (aaben) varAaben.current = true;
    else if (varAaben.current) {
      varAaben.current = false;
      knapRef.current?.focus();
    }
  }, [aaben]);

  useEffect(() => {
    if (!aaben) return;
    feltRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sender) {
        setAaben(false);
        return;
      }
      // Hold Tab inde i dialogen (aria-modal).
      if (e.key !== "Tab" || !dialogRef.current) return;
      const felter = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled])",
        ),
      );
      if (felter.length === 0) return;
      const foerste = felter[0];
      const sidste = felter[felter.length - 1];
      const aktiv = document.activeElement;
      if (e.shiftKey && (aktiv === foerste || !dialogRef.current.contains(aktiv))) {
        e.preventDefault();
        sidste.focus();
      } else if (!e.shiftKey && (aktiv === sidste || !dialogRef.current.contains(aktiv))) {
        e.preventDefault();
        foerste.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aaben, sender]);

  function aabn() {
    setSendt(false);
    setFejl(null);
    setAaben(true);
  }

  function luk() {
    if (sender) return;
    setAaben(false);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    // Ref-lås: sender-state fra en gammel closure stopper ikke et hurtigt dobbeltklik.
    if (senderLaas.current || sender || !tekst.trim()) return;
    senderLaas.current = true;
    setSender(true);
    setFejl(null);
    let res: Awaited<ReturnType<typeof sendFaellesbesked>>;
    try {
      res = await sendFaellesbesked(tradeId, tekst);
    } catch {
      res = { fejl: "Noget gik galt. Prøv igen om lidt." };
    } finally {
      senderLaas.current = false;
      setSender(false);
    }
    if ("fejl" in res) {
      setFejl(res.fejl);
      return;
    }
    setTekst("");
    setSendt(true);
    setAaben(false);
  }

  return (
    <>
      <button
        ref={knapRef}
        type="button"
        onClick={aabn}
        aria-haspopup="dialog"
        className="whitespace-nowrap rounded-md bg-[#E8F2EE] px-2 py-1 text-xs text-[#154537] transition-colors hover:bg-[#DCEAE4]"
      >
        Fællesbesked
      </button>
      {sendt && (
        <span role="status" className="block text-xs text-green-700">
          Fællesbesked sendt
        </span>
      )}

      {aaben && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={luk}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-titel`}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-6 text-left shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={`${id}-titel`} className="text-lg font-bold text-neutral-900">
              Fællesbesked til køber og sælger
            </h2>
            <p className="mt-1.5 text-sm text-neutral-500">
              Beskeden vises i chatten mellem køber og sælger, markeret som en besked fra BidHamr. Begge får besked.
            </p>
            <form onSubmit={send} className="mt-4 space-y-4">
              {fejl && (
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  {fejl}
                </p>
              )}
              <div>
                <label htmlFor={`${id}-tekst`} className="block text-sm font-medium text-neutral-700">
                  Besked
                </label>
                <textarea
                  ref={feltRef}
                  id={`${id}-tekst`}
                  value={tekst}
                  onChange={(e) => setTekst(e.target.value)}
                  required
                  rows={5}
                  maxLength={FAELLESBESKED_MAKS_TEKST}
                  aria-describedby={`${id}-taeller`}
                  className="mt-1.5 w-full whitespace-normal rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-groen"
                />
                <p id={`${id}-taeller`} className="mt-1 text-right text-xs text-neutral-500">
                  {tekst.length} / {FAELLESBESKED_MAKS_TEKST} tegn
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  onClick={luk}
                  disabled={sender}
                  className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-200 disabled:opacity-50"
                >
                  Annullér
                </button>
                <button
                  type="submit"
                  disabled={sender || !tekst.trim()}
                  aria-busy={sender}
                  className="inline-flex items-center gap-2 rounded-lg bg-orange-knap px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-knap-mork disabled:opacity-50"
                >
                  {sender && <span className="btn-spinner" aria-hidden="true" />}
                  Send til begge
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
