"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

export interface Besked {
  id: string;
  sender_id: string;
  content: string;
  created_at: string;
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
          const ny = payload.new as Besked;
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

    // Indsættes direkte fra klienten - RLS er autoriteten på hvem der må
    // skrive i hvilken handel.
    const supabase = createClient();
    const { data, error } = await supabase
      .from("messages")
      .insert({ trade_id: tradeId, sender_id: brugerId, content: renTekst })
      .select("id, sender_id, content, created_at")
      .single();

    setSender(false);

    if (error) {
      setFejl("Beskeden kunne ikke sendes.");
      return;
    }

    setTekst("");
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
          const erMig = b.sender_id === brugerId;
          return (
            <div key={b.id} className={`flex ${erMig ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
                  erMig
                    ? "bg-brand text-white"
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
          className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
        <button
          type="submit"
          disabled={sender || !tekst.trim()}
          className="shrink-0 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
        >
          {sender ? "Sender…" : "Send"}
        </button>
      </form>

      {fejl && <p className="px-4 pb-4 text-sm text-red-600">{fejl}</p>}
    </div>
  );
}
