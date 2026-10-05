"use client";

// Brugerens samtale med BidHamr. Nye beskeder kommer via realtime på
// staff_beskeder (RLS + kolonne-grants: kun egne samtaler og kun de
// kolonner, brugeren må se). Svar går gennem svarStaffChat().
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  markerStaffSamtaleLaest,
  svarStaffChat,
  type StaffBesked,
} from "@/app/actions/staffChat";
import { STAFF_CHAT_MAKS_TEKST } from "@/lib/staffChat";
import { BidhamrMaerke, LUKKET_TEKST, beskedTid } from "@/components/staffchat/visning";

function flet(a: StaffBesked[], b: StaffBesked[]): StaffBesked[] {
  const m = new Map<string, StaffBesked>();
  for (const x of [...a, ...b]) if (!m.has(x.id)) m.set(x.id, x);
  return [...m.values()].sort(
    (x, y) => Date.parse(x.oprettet_kl) - Date.parse(y.oprettet_kl) || x.id.localeCompare(y.id),
  );
}

export default function StaffChatBruger({
  samtaleId,
  startBeskeder,
  lukket: lukketFraServer,
}: {
  samtaleId: string;
  startBeskeder: StaffBesked[];
  lukket: boolean;
}) {
  const router = useRouter();
  // Kun beskeder, der er kommet til siden siden serveren tegnede siden.
  const [nye, setNye] = useState<StaffBesked[]>([]);
  const [lukketLokalt, setLukketLokalt] = useState(false);
  const [tekst, setTekst] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const bundRef = useRef<HTMLLIElement>(null);
  const feltId = useId();
  const fejlId = useId();

  const beskeder = useMemo(() => flet(startBeskeder, nye), [startBeskeder, nye]);
  const lukket = lukketFraServer || lukketLokalt;

  useEffect(() => {
    const supabase = createClient();
    const kanal = supabase
      .channel(`staffchat-${samtaleId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "staff_beskeder",
          filter: `samtale_id=eq.${samtaleId}`,
        },
        (payload) => {
          const r = payload.new as Partial<StaffBesked> & { samtale_id?: string };
          if (!r.id || typeof r.tekst !== "string" || !r.oprettet_kl) {
            // Uventet indhold: hent siden igen i stedet for at gætte.
            router.refresh();
            return;
          }
          const ny: StaffBesked = {
            id: r.id,
            fra_staff: !!r.fra_staff,
            tekst: r.tekst,
            oprettet_kl: r.oprettet_kl,
          };
          setNye((t) => (t.some((b) => b.id === ny.id) ? t : [...t, ny]));
          // Brugeren kigger på samtalen, så beskeden er læst.
          if (ny.fra_staff) void markerStaffSamtaleLaest(samtaleId);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(kanal);
    };
  }, [samtaleId, router]);

  // Kommer brugeren tilbage til fanen, hentes samtalen igen (fx hvis den er
  // blevet afsluttet imens).
  useEffect(() => {
    function vedSynlig() {
      if (document.visibilityState === "visible") router.refresh();
    }
    document.addEventListener("visibilitychange", vedSynlig);
    return () => document.removeEventListener("visibilitychange", vedSynlig);
  }, [router]);

  useEffect(() => {
    bundRef.current?.scrollIntoView({ block: "end" });
  }, [beskeder.length]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const ren = tekst.trim();
    if (!ren || sender) return;
    setSender(true);
    setFejl(null);
    const svar = await svarStaffChat(samtaleId, ren);
    setSender(false);
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      // Afsluttet imens: skjul svarfeltet og vis forklaringen.
      if (svar.fejl.startsWith("Samtalen er afsluttet")) setLukketLokalt(true);
      return;
    }
    setTekst("");
    setNye((t) => (t.some((b) => b.id === svar.besked.id) ? t : [...t, svar.besked]));
  }

  return (
    <section
      aria-label="Beskeder"
      className="overflow-hidden rounded-[14px] border border-kant bg-white"
    >
      <ol className="max-h-[60vh] space-y-4 overflow-y-auto px-4 py-5 sm:px-5" aria-live="polite">
        {beskeder.length === 0 && (
          <li className="py-6 text-center text-sm text-tekst-svag">Ingen beskeder endnu.</li>
        )}
        {beskeder.map((b) =>
          b.fra_staff ? (
            <li key={b.id} className="flex flex-col items-start gap-1.5">
              <BidhamrMaerke lille />
              <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-succes-kant bg-groen-lys px-4 py-3 text-[15px] text-tekst sm:max-w-[75%]">
                <p className="whitespace-pre-wrap break-words">{b.tekst}</p>
                <p className="mt-1 text-[12px] text-tekst-svag">
                  <span className="sr-only">Fra BidHamr, </span>
                  <time dateTime={b.oprettet_kl}>{beskedTid(b.oprettet_kl)}</time>
                </p>
              </div>
            </li>
          ) : (
            <li key={b.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-groen px-4 py-3 text-[15px] text-white sm:max-w-[75%]">
                <p className="whitespace-pre-wrap break-words">{b.tekst}</p>
                <p className="mt-1 text-[12px] text-white/85">
                  <span className="sr-only">Dig, </span>
                  <time dateTime={b.oprettet_kl}>{beskedTid(b.oprettet_kl)}</time>
                </p>
              </div>
            </li>
          ),
        )}
        <li ref={bundRef} aria-hidden="true" />
      </ol>

      {lukket ? (
        <div className="border-t border-kant bg-[#F7F7F7] px-4 py-4 text-sm text-tekst-daempet sm:px-5" role="status">
          {LUKKET_TEKST}
        </div>
      ) : (
        <form onSubmit={send} className="border-t border-kant p-4 sm:px-5">
          <label htmlFor={feltId} className="sr-only">
            Skriv et svar til BidHamr
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <textarea
              id={feltId}
              value={tekst}
              onChange={(e) => setTekst(e.target.value)}
              placeholder="Skriv et svar…"
              rows={2}
              maxLength={STAFF_CHAT_MAKS_TEKST}
              aria-invalid={fejl ? true : undefined}
              aria-describedby={fejl ? fejlId : undefined}
              className="min-h-11 w-full min-w-0 flex-1 resize-y rounded-xl border border-kant-staerk bg-white px-4 py-2.5 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
            />
            <button
              type="submit"
              disabled={sender || !tekst.trim()}
              aria-busy={sender}
              className="btn btn-primaer w-full sm:w-auto"
            >
              {sender && <span className="btn-spinner" aria-hidden="true" />}
              Send
            </button>
          </div>
          {fejl && (
            <p id={fejlId} role="alert" className="mt-2 text-[13px] font-medium text-fejl-tekst">
              {fejl}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
