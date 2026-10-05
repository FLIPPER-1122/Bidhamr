"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { fjernFaellesPraefiks } from "@/lib/staffChat";
import { BidhamrMaerke } from "@/components/staffchat/visning";
import RapporterDialog from "@/components/tryghed/RapporterDialog";
import { spamForklaring } from "@/lib/tryghed";

export interface Besked {
  id: string;
  sender_id: string;
  content: string;
  created_at: string;
  // true = fællesbesked fra BidHamr til begge parter. Kun denne kolonne
  // afgør markeringen - aldrig teksten.
  fra_bidhamr: boolean;
  // Sat af spamfilteret: beskeden blev ikke sendt (ses kun af afsenderen).
  blokeret_grund?: string | null;
}

export default function HandelChat({
  tradeId,
  brugerId,
  modpartNavn,
  startBeskeder,
}: {
  tradeId: string;
  brugerId: string;
  modpartNavn: string;
  startBeskeder: Besked[];
}) {
  const [beskeder, setBeskeder] = useState<Besked[]>(startBeskeder);
  const [tekst, setTekst] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  // Venlig forklaring, når spamfilteret har stoppet en besked.
  const [stoppet, setStoppet] = useState<string | null>(null);
  const bundRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`handel-${tradeId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `trade_id=eq.${tradeId}`,
        },
        (payload) => {
          const r = payload.new as Besked;
          const ny: Besked = {
            id: r.id,
            sender_id: r.sender_id,
            content: r.content,
            created_at: r.created_at,
            fra_bidhamr: r.fra_bidhamr === true,
            blokeret_grund: r.blokeret_grund ?? null,
          };
          // Dedup: egne beskeder kan nå frem både via insert-svaret og realtime.
          setBeskeder((tidligere) =>
            tidligere.some((b) => b.id === ny.id) ? tidligere : [...tidligere, ny],
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tradeId]);

  useEffect(() => {
    bundRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [beskeder.length]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const renTekst = tekst.trim();
    if (!renTekst) return;

    setSender(true);
    setFejl(null);
    setStoppet(null);

    // Indsættes direkte fra klienten - RLS er autoriteten på hvem der må
    // skrive i hvilken handel.
    const supabase = createClient();
    const { data, error } = await supabase
      .from("messages")
      .insert({ trade_id: tradeId, sender_id: brugerId, content: renTekst })
      .select("id, sender_id, content, created_at, fra_bidhamr, blokeret_grund")
      .single<Besked>();

    setSender(false);

    if (error) {
      // BHM01: databasen afviser beskeder, der udgiver sig for at være fra BidHamr.
      // BHS02: kontoen er suspenderet (kraev_ikke_suspenderet).
      // BHB01: en af jer har blokeret den anden, og handlen er afsluttet.
      // BHM03: for mange beskeder på kort tid (messages_tryghed).
      setFejl(
        error.code === "BHM01"
          ? "Beskeder må ikke starte med 'Besked fra BidHamr'."
          : error.code === "BHS02"
            ? "Din konto er suspenderet, og du kan ikke sende beskeder. Kontakt support@bidhamr.dk, hvis du mener, det er en fejl."
            : error.code === "BHB01"
              ? "Du kan ikke skrive til denne bruger længere."
              : error.code === "BHM03"
                ? "Du sender beskeder meget hurtigt. Vent et øjeblik, og prøv så igen."
                : "Beskeden kunne ikke sendes.",
      );
      return;
    }

    if (data?.blokeret_grund) {
      // Beholdes i feltet, så brugeren kan rette beskeden.
      setStoppet(spamForklaring(data.blokeret_grund));
    } else {
      setTekst("");
    }
    if (data) {
      setBeskeder((tidligere) =>
        tidligere.some((b) => b.id === data.id) ? tidligere : [...tidligere, data],
      );
    }
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white">
      <div className="border-b border-neutral-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-neutral-900">
          Beskeder med {modpartNavn}
        </h2>
      </div>

      <div className="max-h-96 space-y-3 overflow-y-auto px-5 py-4">
        {beskeder.length === 0 && (
          <p className="py-6 text-center text-sm text-neutral-400">
            Ingen beskeder endnu. Skriv den første.
          </p>
        )}
        {beskeder.map((b) => {
          if (b.fra_bidhamr) {
            // Fællesbesked: vises som BidHamr, aldrig med afsenderens navn.
            return (
              <div key={b.id} className="flex flex-col items-start gap-1.5">
                <BidhamrMaerke lille />
                <div className="max-w-[85%] rounded-2xl rounded-tl-md border border-[#B9D8CC] bg-groen-lys px-4 py-2.5 text-sm text-tekst sm:max-w-[75%]">
                  <p className="whitespace-pre-wrap break-words">
                    <span className="sr-only">Besked fra BidHamr: </span>
                    {fjernFaellesPraefiks(b.content, b.fra_bidhamr)}
                  </p>
                  <p className="mt-1 text-[12px] text-tekst-svag">
                    {new Date(b.created_at).toLocaleString("da-DK", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            );
          }
          const erMig = b.sender_id === brugerId;
          if (erMig && b.blokeret_grund) {
            // Stoppet af spamfilteret - modtageren har ikke set den.
            return (
              <div key={b.id} className="flex flex-col items-end gap-1">
                <div className="max-w-[85%] rounded-2xl border border-dashed border-kant-staerk bg-white px-4 py-2.5 text-sm text-tekst-svag sm:max-w-[75%]">
                  <p className="whitespace-pre-wrap break-words line-through">{b.content}</p>
                </div>
                <p className="max-w-[85%] text-right text-[12px] text-fejl-tekst sm:max-w-[75%]">
                  Ikke sendt. {spamForklaring(b.blokeret_grund)}
                </p>
              </div>
            );
          }
          return (
            <div
              key={b.id}
              className={`flex flex-col ${erMig ? "items-end" : "items-start"}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
                  erMig
                    ? "bg-orange-knap text-white"
                    : "bg-neutral-100 text-neutral-800"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{b.content}</p>
                <p
                  className={`mt-1 text-[11px] ${
                    erMig ? "text-white/70" : "text-neutral-400"
                  }`}
                >
                  {new Date(b.created_at).toLocaleString("da-DK", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              {!erMig && (
                <RapporterDialog
                  beskedId={b.id}
                  titel="Rapportér besked"
                  triggerLabel="Rapportér"
                  triggerClassName="mt-0.5 px-1 py-1 text-[12px] text-tekst-svag hover:text-groen hover:underline"
                />
              )}
            </div>
          );
        })}
        <div ref={bundRef} />
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-neutral-100 p-4">
        <input
          type="text"
          value={tekst}
          onChange={(e) => setTekst(e.target.value)}
          placeholder="Skriv en besked..."
          maxLength={2000}
          className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-groen focus:ring-1 focus:ring-groen"
        />
        <button
          type="submit"
          disabled={sender || !tekst.trim()}
          className="shrink-0 rounded-lg bg-orange-knap px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-knap-mork disabled:opacity-50"
        >
          {sender ? "Sender…" : "Send"}
        </button>
      </form>

      {stoppet && (
        <p role="status" className="mx-4 mb-4 rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-sm text-advarsel-tekst">
          {stoppet}
        </p>
      )}
      {fejl && <p role="alert" className="px-4 pb-4 text-sm text-fejl-tekst">{fejl}</p>}
    </div>
  );
}
