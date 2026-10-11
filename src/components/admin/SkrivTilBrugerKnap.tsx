"use client";

// Hurtighandling "Svar" / "Send påmindelse": skriver til en bruger i
// staff-chatten (aabnChat - findes der en åben samtale, lægges beskeden i
// den) UDEN at forlade listen. Standardsvar sættes ind med ét klik.
// Svarer man på en kontaktformular, markeres henvendelsen som besvaret i
// samme klik (kontaktMarkerBesvaret), medmindre man fjerner krydset.
// Serveren tjekker rollen igen ved hver handling.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { aabnChat } from "@/app/actions/staffChat";
import { kontaktMarkerBesvaret } from "@/app/actions/adminTryghed";
import { STAFF_CHAT_MAKS_EMNE, STAFF_CHAT_MAKS_TEKST } from "@/lib/staffChat";
import { visKvittering } from "@/components/admin/Kvittering";
import Skabeloner, { type Skabelon } from "@/components/admin/Skabeloner";

export default function SkrivTilBrugerKnap({
  brugerId,
  brugerNavn,
  tradeId,
  knapTekst,
  knapKlasse = "btn btn-primaer btn-lille",
  titel,
  emne: startEmne = "",
  tekst: startTekst = "",
  skabeloner = [],
  henvendelseId,
  kvittering = "Beskeden er sendt",
}: {
  brugerId: string;
  brugerNavn: string;
  tradeId?: string | null;
  knapTekst: string;
  knapKlasse?: string;
  titel?: string;
  emne?: string;
  tekst?: string;
  skabeloner?: readonly Skabelon[];
  // Svar på en kontaktformular: markér den besvaret i samme klik.
  henvendelseId?: string;
  kvittering?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [emne, setEmne] = useState(startEmne);
  const [besked, setBesked] = useState(startTekst);
  const [marker, setMarker] = useState(true);
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const tekstRef = useRef<HTMLTextAreaElement>(null);
  const knapRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!aaben) return;
    tekstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sender) setAaben(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aaben, sender]);

  function luk() {
    if (sender) return;
    setAaben(false);
    setFejl(null);
    knapRef.current?.focus();
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (sender) return;
    if (!besked.trim()) {
      setFejl("Skriv en besked.");
      return;
    }
    setSender(true);
    setFejl(null);
    try {
      const res = await aabnChat(brugerId, emne, { tradeId: tradeId ?? null, besked: besked.trim() });
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      if (henvendelseId && marker) {
        const fd = new FormData();
        fd.set("henvendelseId", henvendelseId);
        const m = await kontaktMarkerBesvaret(fd);
        if ("fejl" in m) {
          // Beskeden ER sendt - sig det, så man ikke sender den igen.
          visKvittering(`Beskeden er sendt, men henvendelsen kunne ikke markeres som besvaret: ${m.fejl}`, { fejl: true });
          setAaben(false);
          router.refresh();
          return;
        }
      }
      setAaben(false);
      visKvittering(henvendelseId && marker ? `${kvittering} – henvendelsen er markeret som besvaret` : kvittering, {
        link: { href: `/admin/chats/${res.samtaleId}`, label: "Åbn chatten" },
      });
      router.refresh();
    } catch {
      setFejl("Noget gik galt. Prøv igen.");
    } finally {
      setSender(false);
    }
  }

  return (
    <>
      <button ref={knapRef} type="button" onClick={() => setAaben(true)} aria-haspopup="dialog" className={knapKlasse}>
        {knapTekst}
      </button>

      {aaben && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={luk}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-titel`}
            className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-stor sm:rounded-2xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={`${id}-titel`} className="text-lg font-bold text-tekst">
              {titel ?? `Skriv til ${brugerNavn}`}
            </h2>
            <p className="mt-1.5 text-sm text-tekst-daempet">
              {brugerNavn} får beskeden i staff-chatten og en notifikation, og kan svare under Beskeder.
            </p>

            <form onSubmit={send} className="mt-4 space-y-4">
              {fejl && (
                <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
                  {fejl}
                </p>
              )}
              <div>
                <label htmlFor={`${id}-emne`} className="block text-sm font-medium text-tekst">
                  Emne
                </label>
                <input
                  id={`${id}-emne`}
                  value={emne}
                  onChange={(e) => setEmne(e.target.value)}
                  required
                  maxLength={STAFF_CHAT_MAKS_EMNE}
                  className="mt-1.5 h-11 w-full rounded-lg border border-kant-staerk px-3 text-base focus:outline-none focus:ring-2 focus:ring-groen sm:text-sm"
                />
              </div>
              <div>
                <label htmlFor={`${id}-besked`} className="block text-sm font-medium text-tekst">
                  Besked
                </label>
                {skabeloner.length > 0 && <Skabeloner skabeloner={skabeloner} onVaelg={setBesked} feltId={`${id}-besked`} />}
                <textarea
                  ref={tekstRef}
                  id={`${id}-besked`}
                  value={besked}
                  onChange={(e) => setBesked(e.target.value)}
                  required
                  maxLength={STAFF_CHAT_MAKS_TEKST}
                  rows={5}
                  className="mt-1.5 w-full rounded-lg border border-kant-staerk px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-groen sm:text-sm"
                />
              </div>
              {henvendelseId && (
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-tekst">
                  <input
                    type="checkbox"
                    checked={marker}
                    onChange={(e) => setMarker(e.target.checked)}
                    className="h-5 w-5 shrink-0 accent-[#1E5E4A]"
                  />
                  Markér henvendelsen som besvaret
                </label>
              )}
              <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end sm:gap-3">
                <button type="button" onClick={luk} disabled={sender} className="btn btn-sekundaer">
                  Annullér
                </button>
                <button type="submit" disabled={sender || !emne.trim()} aria-busy={sender} className="btn btn-primaer">
                  {sender && <span className="btn-spinner" aria-hidden="true" />}
                  Send
                </button>
              </div>
              <p className="text-xs text-tekst-svag">
                Hele samtalen kan ses under <Link href="/admin/chats" className="underline">Chats</Link>.
              </p>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
