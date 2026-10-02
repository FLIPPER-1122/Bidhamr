"use client";

// Samtalevisning for staff. Staff har ikke realtime på staff_beskeder, så
// siden hentes igen hvert 15. sekund, mens fanen er synlig og chatten er åben.
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
  lukChat,
  sendStaffBesked,
  type StaffBeskedAdmin,
} from "@/app/actions/staffChat";
import { STAFF_CHAT_MAKS_TEKST } from "@/lib/staffChat";
import BekraeftDialog from "@/components/BekraeftDialog";
import { beskedTid } from "@/components/staffchat/visning";

const POLL_MS = 15_000;

function flet(a: StaffBeskedAdmin[], b: StaffBeskedAdmin[]): StaffBeskedAdmin[] {
  const m = new Map<string, StaffBeskedAdmin>();
  for (const x of [...a, ...b]) if (!m.has(x.id)) m.set(x.id, x);
  return [...m.values()].sort(
    (x, y) => Date.parse(x.oprettet_kl) - Date.parse(y.oprettet_kl) || x.id.localeCompare(y.id),
  );
}

export default function StaffChatAdmin({
  samtaleId,
  brugerNavn,
  beskeder: fraServer,
  lukket,
}: {
  samtaleId: string;
  brugerNavn: string;
  beskeder: StaffBeskedAdmin[];
  lukket: boolean;
}) {
  const router = useRouter();
  const [sendte, setSendte] = useState<StaffBeskedAdmin[]>([]);
  const [tekst, setTekst] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const bundRef = useRef<HTMLLIElement>(null);
  const feltId = useId();
  const fejlId = useId();

  const beskeder = useMemo(() => flet(fraServer, sendte), [fraServer, sendte]);

  useEffect(() => {
    if (lukket) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, POLL_MS);
    function vedSynlig() {
      if (document.visibilityState === "visible") router.refresh();
    }
    document.addEventListener("visibilitychange", vedSynlig);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", vedSynlig);
    };
  }, [lukket, router]);

  useEffect(() => {
    bundRef.current?.scrollIntoView({ block: "end" });
  }, [beskeder.length]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const ren = tekst.trim();
    if (!ren || sender) return;
    setSender(true);
    setFejl(null);
    const res = await sendStaffBesked(samtaleId, ren);
    setSender(false);
    if ("fejl" in res) {
      setFejl(res.fejl);
      router.refresh();
      return;
    }
    setTekst("");
    setSendte((t) => [
      ...t,
      { id: res.beskedId, fra_staff: true, tekst: ren, oprettet_kl: new Date().toISOString(), afsender_navn: "Dig" },
    ]);
    router.refresh();
  }

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold text-neutral-800">Samtale med {brugerNavn}</h2>
        {lukket ? (
          <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600">
            Afsluttet
          </span>
        ) : (
          <BekraeftDialog
            triggerLabel="Afslut chat"
            triggerClassName="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50"
            title="Afslut chatten?"
            description="Brugeren kan ikke skrive mere i samtalen bagefter. Samtalen gemmes og kan stadig læses."
            confirmLabel="Ja, afslut chatten"
            onConfirm={async () => {
              const res = await lukChat(samtaleId);
              return "fejl" in res ? { fejl: res.fejl } : undefined;
            }}
            onSuccess={() => router.refresh()}
          />
        )}
      </div>

      <ol className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite">
        {beskeder.length === 0 && (
          <li className="py-6 text-center text-sm text-neutral-400">
            Ingen beskeder endnu. Skriv den første.
          </li>
        )}
        {beskeder.map((b) => (
          <li key={b.id} className={`flex ${b.fra_staff ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm sm:max-w-[75%] ${
                b.fra_staff ? "bg-[#E8F2EE] text-[#154537]" : "bg-neutral-100 text-neutral-800"
              }`}
            >
              <p className="mb-0.5 text-xs font-semibold">
                {b.fra_staff ? `BidHamr · ${b.afsender_navn ?? "medarbejder"}` : brugerNavn}
              </p>
              <p className="whitespace-pre-wrap break-words">{b.tekst}</p>
              <p className="mt-1 text-xs text-neutral-500">
                <time dateTime={b.oprettet_kl}>{beskedTid(b.oprettet_kl)}</time>
              </p>
            </div>
          </li>
        ))}
        <li ref={bundRef} aria-hidden="true" />
      </ol>

      {lukket ? (
        <p className="border-t border-neutral-100 bg-neutral-50 px-4 py-4 text-sm text-neutral-600 sm:px-5" role="status">
          Chatten er afsluttet. Brugeren kan ikke skrive mere, og der kan ikke sendes flere beskeder.
        </p>
      ) : (
        <form onSubmit={send} className="border-t border-neutral-100 p-4 sm:px-5">
          <label htmlFor={feltId} className="sr-only">
            Skriv til {brugerNavn}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <textarea
              id={feltId}
              value={tekst}
              onChange={(e) => setTekst(e.target.value)}
              rows={3}
              maxLength={STAFF_CHAT_MAKS_TEKST}
              placeholder="Skriv en besked…"
              aria-invalid={fejl ? true : undefined}
              aria-describedby={fejl ? fejlId : undefined}
              className="min-h-11 w-full min-w-0 flex-1 resize-y rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
            <button
              type="submit"
              disabled={sender || !tekst.trim()}
              aria-busy={sender}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-orange-knap px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-orange-knap-mork disabled:opacity-50"
            >
              {sender && <span className="btn-spinner" aria-hidden="true" />}
              Send
            </button>
          </div>
          {fejl && (
            <p id={fejlId} role="alert" className="mt-2 text-sm text-red-700">
              {fejl}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
