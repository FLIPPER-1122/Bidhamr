"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { afgivBud } from "@/app/actions/bud";
import { formatNedtælling } from "@/lib/auctionTid";
import { kroner } from "@/lib/kroner";
import {
  KOEBERGEBYR_PROCENT,
  beskyttelseOere,
  fragtOere,
  totalOere,
} from "@/lib/betaling/beregn";
import { BIDPANEL } from "@/lib/tekster/beskyttelse";

// Budhistorikken er anonymiseret paa serveren: ingen bruger-id'er eller navne
// i browseren - kun "Byder 3" eller "Dig".
export interface BidPanelBud {
  id: string;
  beløb: number;
  oprettet: string;
  byder: string;
  erMig: boolean;
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
  status,
  vinderVisning,
}: {
  auktionId: string;
  initialNuværendeBud: number;
  initialSlutterKl: string;
  initialBud: BidPanelBud[];
  brugerId: string | null;
  saelgerId: string;
  forsendelseMulig: boolean;
  status: string;
  // Anonym vinderbetegnelse fra serveren ("Dig" / "Byder 2") - aldrig navn/id.
  vinderVisning: string | null;
}) {
  const [nuværendeBud, setNuværendeBud] = useState(initialNuværendeBud);
  const [slutterKl, setSlutterKl] = useState(initialSlutterKl);
  const [budListe, setBudListe] = useState<BidPanelBud[]>(initialBud);
  // Ny budhistorik kommer fra serveren ved router.refresh().
  const [forrigeInitialBud, setForrigeInitialBud] = useState(initialBud);
  if (initialBud !== forrigeInitialBud) {
    setForrigeInitialBud(initialBud);
    setBudListe(initialBud);
  }
  const [visAlle, setVisAlle] = useState(false);
  const [beløb, setBeløb] = useState("");
  // BidHamr Beskyttelse: ikke valgt på forhånd. Gemmes med buddet.
  const [beskyttelse, setBeskyttelse] = useState(false);
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<string>("aktiv");
  const auktionStatus = status !== "aktiv" ? status : realtimeStatus;
  // Nedtællingen afhænger af klokken og beregnes først efter mount, så
  // server- og klient-render er ens (ingen hydration-mismatch).
  const [nedtælling, setNedtælling] = useState<string | null>(null);

  // Sælgere må ikke byde på egen auktion - databasen afviser det også.
  const erSælger = Boolean(brugerId && brugerId === saelgerId);

  const nuværendeBudRef = useRef(nuværendeBud);
  useEffect(() => {
    nuværendeBudRef.current = nuværendeBud;
  }, [nuværendeBud]);

  // Sættes når nedtællingen er kørt i nul, så genindlæsningen kun sker én
  // gang - også selv om auktionen forlænges og tælleren starter forfra.
  const harLukketRef = useRef(false);

  useEffect(() => {
    const opdater = () => setNedtælling(formatNedtælling(slutterKl));
    const foerste = setTimeout(opdater, 0);
    const id = setInterval(() => {
      opdater();

      const slut = new Date(slutterKl).getTime() - Date.now() <= 0;
      if (!slut || harLukketRef.current) return;

      harLukketRef.current = true;

      // Siden er server-renderet, så vinder- og sælgerboksen dukker ikke op
      // af sig selv, når tiden løber ud. pg_cron lukker auktionen inden for
      // et minut; vi venter lidt, så vinderen er sat, før vi henter igen.
      setTimeout(() => router.refresh(), 2000);
    }, 1000);
    return () => {
      clearTimeout(foerste);
      clearInterval(id);
    };
  }, [slutterKl, router]);

  useEffect(() => {
    const supabase = createClient();

    // Bud kan ikke laeses direkte (bydernes privatliv), saa der lyttes paa
    // auktionen: aendres det foerende bud, hentes den anonymiserede
    // budhistorik og min status igen fra serveren.
    const channel = supabase
      .channel(`auktion-${auktionId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "auctions",
          filter: `id=eq.${auktionId}`,
        },
        (payload) => {
          const opdateret = payload.new as {
            "nuværende_bud": number | null;
            slutter_kl: string;
            status: string;
          };
          if (
            opdateret["nuværende_bud"] != null &&
            opdateret["nuværende_bud"] !== nuværendeBudRef.current
          ) {
            setNuværendeBud(opdateret["nuværende_bud"]);
            router.refresh();
          }
          setSlutterKl(opdateret.slutter_kl);
          // Anti-sniping kan forlænge auktionen efter at tælleren er nået
          // nul; så skal den kunne udløse en genindlæsning igen.
          if (new Date(opdateret.slutter_kl).getTime() > Date.now()) {
            harLukketRef.current = false;
          }
          if (opdateret.status && opdateret.status !== "aktiv") {
            setRealtimeStatus(opdateret.status);
            // Vinderen hentes anonymt fra serveren (vinderVisning-prop).
            router.refresh();
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [auktionId, brugerId, router]);

  // Første bud må være lig startprisen; derefter mindst 10 % over nuværende bud.
  const harBud = budListe.length > 0;
  const minimumBud = harBud ? Math.ceil(nuværendeBud * 1.1) : Math.ceil(nuværendeBud);

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

  // Kun visning: prisen for BidHamr Beskyttelse på det indtastede bud.
  const beskyttelsePrisOere =
    beløb.trim() !== "" && Number.isFinite(budTal) && budTal > 0
      ? beskyttelseOere(Math.round(budTal * 100))
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

    if (!Number.isFinite(beløbTal) || !Number.isInteger(beløbTal) || beløbTal < minimumBud) {
      setError(
        harBud
          ? `Dit bud skal være mindst ${minimumBud.toLocaleString("da-DK")} kr (10% over nuværende bud).`
          : `Dit bud skal være mindst ${minimumBud.toLocaleString("da-DK")} kr (startprisen).`,
      );
      return;
    }

    setLoading(true);

    // Afgives paa serveren (rate limit). RLS og triggere gaelder uaendret.
    const svar = await afgivBud(auktionId, beløbTal, beskyttelse);

    if ("fejl" in svar) {
      setLoading(false);
      setError(svar.fejl);
      return;
    }

    // Anti-sniping sker på serveren (handle_new_bid-triggeren forlænger
    // slutter_kl i samme transaktion som buddet).
    if (
      svar.slutterKl &&
      new Date(svar.slutterKl).getTime() > new Date(slutterKl).getTime()
    ) {
      setSlutterKl(svar.slutterKl);
      setInfo("Auktionen er forlænget med 2 minutter!");
      setTimeout(() => setInfo(null), 6000);
    }

    setLoading(false);
    setBeløb("");

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
          {nedtælling ?? "–"}
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
              {vinderVisning ? (
                <p className="mt-1 text-sm text-neutral-500">
                  Vinder: <span className="font-semibold text-neutral-700">{vinderVisning}</span>
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
        <form onSubmit={handleSubmit} noValidate className="mt-4 flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="number"
            inputMode="numeric"
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

          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={beskyttelse}
                onChange={(e) => setBeskyttelse(e.target.checked)}
                className="h-4 w-4 shrink-0 accent-[#1E5E4A]"
              />
              <span className="text-sm font-semibold text-neutral-800">
                {BIDPANEL.beskyttelseLabel}
                {beskyttelsePrisOere !== null && (
                  <span className="ml-1 font-normal text-neutral-600">
                    + {kroner(beskyttelsePrisOere)}
                  </span>
                )}
              </span>
            </label>
            {/* Uden for label, så et klik ikke slår afkrydsningen til/fra. */}
            <Link
              href={BIDPANEL.laesMereHref}
              className="text-sm font-medium text-groen underline-offset-2 hover:underline"
            >
              {BIDPANEL.laesMere}
            </Link>
          </div>

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
        {BIDPANEL.prisLinje}
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
                      {bud.byder}
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
