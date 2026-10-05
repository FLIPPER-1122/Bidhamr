"use client";

// "Åbn chat" med en bruger (admin-brugersiden). Emne er påkrævet, første
// besked valgfri. Findes der allerede en åben samtale, lægger aabnChat()
// beskeden i den (ingen ekstra afsendelse her), og staff får det at vide.
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { aabnChat } from "@/app/actions/staffChat";
import { STAFF_CHAT_MAKS_EMNE, STAFF_CHAT_MAKS_TEKST } from "@/lib/staffChat";

export default function AabnChatKnap({
  brugerId,
  brugerNavn,
  tradeId,
}: {
  brugerId: string;
  brugerNavn: string;
  tradeId?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [emne, setEmne] = useState("");
  const [besked, setBesked] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const emneRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!aaben) return;
    emneRef.current?.focus();
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
  }

  async function opret(e: FormEvent) {
    e.preventDefault();
    if (sender) return;
    setSender(true);
    setFejl(null);
    const ren = besked.trim();
    const res = await aabnChat(brugerId, emne, { tradeId: tradeId ?? null, besked: ren || null });
    if ("fejl" in res) {
      setSender(false);
      setFejl(res.fejl);
      return;
    }
    // sender forbliver true, indtil siden skifter, så der ikke kan klikkes igen.
    router.push(`/admin/chats/${res.samtaleId}${res.fandtes ? "?fandtes=1" : ""}`);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setAaben(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-[#E8F2EE] px-4 py-2.5 text-sm font-semibold text-[#154537] transition-colors hover:bg-[#DCEAE4]"
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
        </svg>
        Åbn chat
      </button>

      {aaben && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={luk}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-titel`}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={`${id}-titel`} className="text-lg font-bold text-neutral-900">
              Åbn chat med {brugerNavn}
            </h2>
            <p className="mt-1.5 text-sm text-neutral-500">
              Brugeren får besked og kan svare under Beskeder, indtil du afslutter chatten.
            </p>

            <form onSubmit={opret} className="mt-4 space-y-4">
              {fejl && (
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  {fejl}
                </p>
              )}
              <div>
                <label htmlFor={`${id}-emne`} className="block text-sm font-medium text-neutral-700">
                  Emne
                </label>
                <input
                  ref={emneRef}
                  id={`${id}-emne`}
                  value={emne}
                  onChange={(e) => setEmne(e.target.value)}
                  required
                  maxLength={STAFF_CHAT_MAKS_EMNE}
                  placeholder="Fx: Spørgsmål om din handel"
                  className="mt-1.5 h-11 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-groen"
                />
                <p className="mt-1 text-xs text-neutral-500">Brugeren kan se emnet.</p>
              </div>
              <div>
                <label htmlFor={`${id}-besked`} className="block text-sm font-medium text-neutral-700">
                  Første besked <span className="font-normal text-neutral-500">(valgfri)</span>
                </label>
                <textarea
                  id={`${id}-besked`}
                  value={besked}
                  onChange={(e) => setBesked(e.target.value)}
                  maxLength={STAFF_CHAT_MAKS_TEKST}
                  rows={4}
                  placeholder="Skriv til brugeren…"
                  className="mt-1.5 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-groen"
                />
              </div>
              <div className="flex flex-wrap justify-end gap-3 pt-1">
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
                  disabled={sender || !emne.trim()}
                  aria-busy={sender}
                  className="inline-flex items-center gap-2 rounded-lg bg-orange-knap px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-knap-mork disabled:opacity-50"
                >
                  {sender && <span className="btn-spinner" aria-hidden="true" />}
                  Åbn chat
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
