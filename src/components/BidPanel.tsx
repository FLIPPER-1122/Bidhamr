"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { kortNavn } from "@/lib/kortNavn";
import { formatNedtælling } from "@/lib/auctionTid";

export interface BidPanelBud {
  id: string;
  bruger_id: string;
  beløb: number;
  oprettet: string;
  navn?: string | null;
}

const VIST_SOM_STANDARD = 5;

export default function BidPanel({
  auktionId,
  initialNuværendeBud,
  initialSlutterKl,
  initialBud,
  brugerId,
  forsendelseMulig,
}: {
  auktionId: string;
  initialNuværendeBud: number;
  initialSlutterKl: string;
  initialBud: BidPanelBud[];
  brugerId: string | null;
  forsendelseMulig: boolean;
}) {
  const [nuværendeBud, setNuværendeBud] = useState(initialNuværendeBud);
  const [slutterKl, setSlutterKl] = useState(initialSlutterKl);
  const [budListe, setBudListe] = useState<BidPanelBud[]>(initialBud);
  const [visAlle, setVisAlle] = useState(false);
  const [beløb, setBeløb] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [auktionStatus, setAuktionStatus] = useState<string>("aktiv");
  const [vinderNavn, setVinderNavn] = useState<string | null>(null);
  const [nedtælling, setNedtælling] = useState(() =>
    formatNedtælling(initialSlutterKl),
  );

  const nuværendeBudRef = useRef(nuværendeBud);
  nuværendeBudRef.current = nuværendeBud;

  useEffect(() => {
    const id = setInterval(() => {
      setNedtælling(formatNedtælling(slutterKl));
    }, 1000);
    return () => clearInterval(id);
  }, [slutterKl]);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`auktion-${auktionId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "bids",
          filter: `auktion_id=eq.${auktionId}`,
        },
        async (payload) => {
          const nytBud = payload.new as BidPanelBud;
          const { data: bruger } = await supabase
            .from("users")
            .select("navn")
            .eq("id", nytBud.bruger_id)
            .single();
          setBudListe((prev) => [{ ...nytBud, navn: bruger?.navn ?? null }, ...prev]);
          if (nytBud.beløb > nuværendeBudRef.current) {
            setNuværendeBud(nytBud.beløb);
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "auctions",
          filter: `id=eq.${auktionId}`,
        },
        async (payload) => {
          const opdateret = payload.new as {
            "nuværende_bud": number | null;
            slutter_kl: string;
            status: string;
            vinder_id: string | null;
          };
          if (opdateret["nuværende_bud"] != null) {
            setNuværendeBud(opdateret["nuværende_bud"]);
          }
          setSlutterKl(opdateret.slutter_kl);
          if (opdateret.status && opdateret.status !== "aktiv") {
            setAuktionStatus(opdateret.status);
            if (opdateret.vinder_id) {
              const { data: vinder } = await createClient()
                .from("users")
                .select("navn")
                .eq("id", opdateret.vinder_id)
                .single();
              setVinderNavn(kortNavn(vinder?.navn ?? null));
            }
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [auktionId]);

  const minimumBud = Math.ceil(nuværendeBud * 1.1);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const beløbTal = Number(beløb);

    if (!brugerId) {
      setError("Du skal være logget ind for at byde.");
      return;
    }

    if (!beløbTal || beløbTal < minimumBud) {
      setError(
        `Dit bud skal være mindst ${minimumBud.toLocaleString("da-DK")} kr (10% over nuværende bud).`,
      );
      return;
    }

    setLoading(true);

    const supabase = createClient();
    const { error: insertError } = await supabase.from("bids").insert({
      auktion_id: auktionId,
      bruger_id: brugerId,
      beløb: beløbTal,
    });

    if (insertError) {
      setLoading(false);
      if (insertError.message.includes("minimum_bid")) {
        setError(
          `Dit bud skal være mindst ${minimumBud.toLocaleString("da-DK")} kr (10% over nuværende bud).`,
        );
      } else {
        setError(insertError.message);
      }
      return;
    }

    // Anti-sniping: forlæng auktion med 2 min hvis den slutter inden for 2 min
    const mstilbage = new Date(slutterKl).getTime() - Date.now();
    if (mstilbage > 0 && mstilbage < 2 * 60 * 1000) {
      const nySlutterKl = new Date(new Date(slutterKl).getTime() + 2 * 60 * 1000).toISOString();
      await supabase
        .from("auctions")
        .update({ slutter_kl: nySlutterKl })
        .eq("id", auktionId);
      setInfo("Auktionen er forlænget med 2 minutter!");
      setTimeout(() => setInfo(null), 6000);
    }

    setLoading(false);
    setBeløb("");
  }

  const visteBud = visAlle ? budListe : budListe.slice(0, VIST_SOM_STANDARD);

  return (
    <div className="border border-neutral-200 bg-white p-4">
      {/* Afslutning + countdown */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-neutral-600">
          Afsluttes:{" "}
          {new Date(slutterKl).toLocaleString("da-DK", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
        <p className="text-2xl font-bold text-[#111] tabular-nums">
          {nedtælling}
        </p>
      </div>

      <div className="my-4 border-t border-neutral-200" />

      {/* Førende bud */}
      <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
        Førende bud:
      </p>
      <p className="text-3xl font-bold text-[#111]">
        {nuværendeBud.toLocaleString("da-DK")} kr
      </p>

      {auktionStatus !== "aktiv" ? (
        <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 px-5 py-4 text-center">
          {auktionStatus === "afsluttet" ? (
            <>
              <p className="text-base font-semibold text-neutral-800">Auktionen er afsluttet</p>
              {vinderNavn ? (
                <p className="mt-1 text-sm text-neutral-500">
                  Vinder: <span className="font-semibold text-neutral-700">{vinderNavn}</span>
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-base font-semibold text-neutral-500">Ingen bud – auktionen er lukket</p>
          )}
        </div>
      ) : brugerId ? (
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            type="number"
            min={minimumBud}
            step={1}
            value={beløb}
            onChange={(e) => setBeløb(e.target.value)}
            placeholder={`Mindst ${minimumBud.toLocaleString("da-DK")} kr`}
            className="flex-1 rounded-lg border border-neutral-300 px-3 py-3 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-brand px-6 py-3 text-base font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
          >
            {loading ? "Afgiver…" : "Afgiv bud"}
          </button>
        </form>
      ) : (
        <Link
          href="/login"
          className="mt-4 block w-full rounded-lg bg-brand px-6 py-3 text-center text-base font-semibold text-white hover:bg-[#d62b38]"
        >
          Log ind for at byde
        </Link>
      )}

      <p className="mt-3 text-xs text-neutral-500">25% moms tillægges ikke.</p>
      {forsendelseMulig && (
        <p className="text-xs text-neutral-500">
          Sælger tilbyder forsendelse mod betaling.
        </p>
      )}

      {info && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 8v4m0 4h.01" />
          </svg>
          {info}
        </div>
      )}

      {error && (
        <div className="mt-3 border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="my-4 border-t border-neutral-200" />

      {/* Budhistorik */}
      <h2 className="text-sm font-semibold text-[#111]">Budhistorik</h2>

      {budListe.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">
          Ingen bud endnu – vær den første.
        </p>
      ) : (
        <>
          <table className="mt-3 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-xs text-neutral-500">
                <th className="py-2 font-medium">Bud</th>
                <th className="py-2 font-medium">Tidspunkt</th>
                <th className="py-2 text-right font-medium">Budgiver</th>
              </tr>
            </thead>
            <tbody>
              {visteBud.map((bud, index) => {
                const fed = index === 0 ? "font-bold text-[#111]" : "text-neutral-700";
                return (
                  <tr key={bud.id} className="border-b border-neutral-100">
                    <td className={`py-2 ${fed}`}>
                      {bud.beløb.toLocaleString("da-DK")} kr
                    </td>
                    <td className={`py-2 ${fed}`}>
                      {new Date(bud.oprettet).toLocaleString("da-DK", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className={`py-2 text-right ${fed}`}>
                      <Link
                        href={`/profil/${bud.bruger_id}`}
                        className="hover:text-brand hover:underline"
                      >
                        {kortNavn(bud.navn)}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {budListe.length > VIST_SOM_STANDARD && (
            <button
              onClick={() => setVisAlle(!visAlle)}
              className="mt-3 text-sm font-medium text-brand"
            >
              {visAlle ? "Vis færre bud" : "Vis al budhistorik"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
