"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { kortNavn } from "@/lib/kortNavn";
import { formatNedtælling } from "@/lib/auctionTid";
import { kroner } from "@/lib/kroner";
import {
  FRAGT_OERE,
  KOEBERGEBYR_PROCENT,
  fragtOere,
  totalOere,
} from "@/lib/betaling/beregn";

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
  saelgerId,
  forsendelseMulig,
}: {
  auktionId: string;
  initialNuværendeBud: number;
  initialSlutterKl: string;
  initialBud: BidPanelBud[];
  brugerId: string | null;
  saelgerId: string;
  forsendelseMulig: boolean;
}) {
  const [nuværendeBud, setNuværendeBud] = useState(initialNuværendeBud);
  const [slutterKl, setSlutterKl] = useState(initialSlutterKl);
  const [budListe, setBudListe] = useState<BidPanelBud[]>(initialBud);
  const [visAlle, setVisAlle] = useState(false);
  const [beløb, setBeløb] = useState("");
  // BidHamr Beskyttelse: ikke valgt på forhånd. Gemmes med buddet.
  const [beskyttelse, setBeskyttelse] = useState(false);
  const router = useRouter();
  // Hvem der fører lige nu. Reservationen følger det seneste bud, fordi
  // minimumsbud-triggeren kræver at hvert bud er højere end det forrige.
  const førendeRef = useRef<string | null>(initialBud[0]?.bruger_id ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [auktionStatus, setAuktionStatus] = useState<string>("aktiv");
  const [vinderNavn, setVinderNavn] = useState<string | null>(null);
  const [nedtælling, setNedtælling] = useState(() =>
    formatNedtælling(initialSlutterKl),
  );

  // Sælgere må ikke byde på egen auktion - databasen afviser det også.
  const erSælger = Boolean(brugerId && brugerId === saelgerId);

  const nuværendeBudRef = useRef(nuværendeBud);
  nuværendeBudRef.current = nuværendeBud;

  // Sættes når nedtællingen er kørt i nul, så genindlæsningen kun sker én
  // gang - også selv om auktionen forlænges og tælleren starter forfra.
  const harLukketRef = useRef(false);

  useEffect(() => {
    const id = setInterval(() => {
      setNedtælling(formatNedtælling(slutterKl));

      const slut = new Date(slutterKl).getTime() - Date.now() <= 0;
      if (!slut || harLukketRef.current) return;

      harLukketRef.current = true;

      // Siden er server-renderet, så vinder- og sælgerboksen dukker ikke op
      // af sig selv, når tiden løber ud. pg_cron lukker auktionen inden for
      // et minut; vi venter lidt, så vinderen er sat, før vi henter igen.
      setTimeout(() => router.refresh(), 2000);
    }, 1000);
    return () => clearInterval(id);
  }, [slutterKl, router]);

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

          // Blev jeg lige overbudt, opdateres siden, så min status passer.
          const varJegFørende = førendeRef.current === brugerId;
          førendeRef.current = nytBud.bruger_id;
          if (varJegFørende && nytBud.bruger_id !== brugerId) {
            router.refresh();
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
          // Anti-sniping kan forlænge auktionen efter at tælleren er nået
          // nul; så skal den kunne udløse en genindlæsning igen.
          if (new Date(opdateret.slutter_kl).getTime() > Date.now()) {
            harLukketRef.current = false;
          }
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
  }, [auktionId, brugerId, router]);

  const minimumBud = Math.ceil(nuværendeBud * 1.1);

  // Kun visning: hvad vinderen kommer til at betale. Det endelige beløb
  // beregnes på serveren, når auktionen slutter.
  const budTal = Number(beløb);
  const estimatOere =
    Number.isFinite(budTal) && budTal >= minimumBud
      ? (() => {
          const budOere = Math.round(budTal * 100);
          return (
            totalOere(
              {
                bud_oere: budOere,
                koebergebyr_oere: Math.round((budOere * KOEBERGEBYR_PROCENT) / 100),
                fragt_oere: fragtOere(forsendelseMulig),
              },
              beskyttelse,
            )
          );
        })()
      : null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const beløbTal = Number(beløb);

    if (!brugerId) {
      setError("Du skal være logget ind for at byde.");
      return;
    }

    if (erSælger) {
      setError("Du kan ikke byde på din egen auktion.");
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
      // Kun et ønske - beløbet beregnes i databasen, når auktionen slutter.
      beskyttelse,
    });

    if (insertError) {
      setLoading(false);
      if (insertError.message.includes("own_auction")) {
        setError("Du kan ikke byde på din egen auktion.");
      } else if (insertError.message.includes("minimum_bid")) {
        setError(
          `Dit bud skal være mindst ${minimumBud.toLocaleString("da-DK")} kr (10% over nuværende bud).`,
        );
      } else {
        setError(insertError.message);
      }
      return;
    }

    // Anti-sniping sker på serveren (handle_new_bid-triggeren forlænger
    // slutter_kl i samme transaktion som buddet). Klienten læser kun det
    // nye sluttidspunkt og fortæller brugeren, hvis auktionen blev forlænget.
    const { data: efterBud } = await supabase
      .from("auctions")
      .select("slutter_kl")
      .eq("id", auktionId)
      .maybeSingle();
    if (
      efterBud?.slutter_kl &&
      new Date(efterBud.slutter_kl).getTime() > new Date(slutterKl).getTime()
    ) {
      setSlutterKl(efterBud.slutter_kl);
      setInfo("Auktionen er forlænget med 2 minutter!");
      setTimeout(() => setInfo(null), 6000);
    }

    setLoading(false);
    setBeløb("");

    førendeRef.current = brugerId;

    router.refresh();
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
      ) : erSælger ? (
        <p className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-center text-sm text-neutral-600">
          Det er din egen auktion – du kan ikke byde på den.
        </p>
      ) : brugerId ? (
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
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
            className="rounded-lg bg-orange-knap px-6 py-3 text-base font-semibold text-white hover:bg-orange-knap-mork disabled:opacity-50"
          >
            {loading ? "Afgiver…" : "Afgiv bud"}
          </button>
          </div>

          <label className="flex cursor-pointer gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
            <input
              type="checkbox"
              checked={beskyttelse}
              onChange={(e) => setBeskyttelse(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#1E5E4A]"
            />
            <span className="text-xs text-neutral-600">
              <span className="block text-sm font-semibold text-neutral-800">
                Tilføj BidHamr Beskyttelse (5 %, min. 25 / maks. 250 kr)
              </span>
              Får du ikke varen, eller er den væsentligt anderledes end beskrevet,
              får du pengene tilbage. Valget gælder, hvis du vinder, og kan ikke
              ændres bagefter.
            </span>
          </label>

          {estimatOere !== null && (
            <p className="text-xs text-neutral-600">
              Vinder du med dette bud, betaler du{" "}
              <span className="font-semibold text-neutral-800">{kroner(estimatOere)}</span>{" "}
              i alt.
            </p>
          )}
        </form>
      ) : (
        <Link
          href="/login"
          className="mt-4 block w-full rounded-lg bg-orange-knap px-6 py-3 text-center text-base font-semibold text-white hover:bg-orange-knap-mork"
        >
          Log ind for at byde
        </Link>
      )}

      <p className="mt-3 text-xs text-neutral-500">
        Vinder du, betaler du dit bud + 5 % købergebyr
        {forsendelseMulig ? ` + ${kroner(FRAGT_OERE)} fragt` : ""} + evt. BidHamr Beskyttelse.
        Du ser totalprisen, før du betaler, og har 48 timer til det. 25% moms tillægges ikke.
      </p>
      {!forsendelseMulig && (
        <p className="text-xs text-neutral-500">
          Kun afhentning – ingen fragt.
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
