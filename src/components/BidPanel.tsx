"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import Ikon from "@/components/Ikon";
import { createClient } from "@/lib/supabase/client";
import { afgivBud, saetMaksimum } from "@/app/actions/bud";
import { AUTOBUD } from "@/lib/tekster/autobud";
import { formatNedtælling, pauseTekst } from "@/lib/auctionTid";
import { kroner } from "@/lib/kroner";
import {
  KOEBERGEBYR_PROCENT,
  beskyttelseOere,
  fragtOere,
  totalOere,
} from "@/lib/betaling/beregn";
import { BIDPANEL } from "@/lib/tekster/beskyttelse";
import { BINDENDE_BUD_TEKST, mindsteNaesteBud } from "@/lib/auktionRegler";

// Budhistorikken er anonymiseret paa serveren: ingen bruger-id'er eller navne
// i browseren - kun "Byder 3" eller "Dig".
export interface BidPanelBud {
  id: string;
  beløb: number;
  oprettet: string;
  byder: string;
  erMig: boolean;
  // Afgivet automatisk af BidHamr (maksimum). Maksimum selv vises aldrig.
  automatisk?: boolean;
}

const VIST_SOM_STANDARD = 5;

export default function BidPanel({
  auktionId,
  initialNuværendeBud,
  startpris,
  initialHarBud,
  redigeretKl: initialRedigeretKl,
  initialSlutterKl,
  initialBud,
  mitMaksimum = null,
  brugerId,
  saelgerId,
  forsendelseMulig,
  status,
  vinderVisning,
  skjult = false,
  pauset = false,
  pauseResterende = null,
}: {
  auktionId: string;
  initialNuværendeBud: number;
  // Startpris = mindstepris. Første bud må være lig startprisen.
  startpris: number;
  // auctions."nuværende_bud" er sat (der er budt).
  initialHarBud: boolean;
  // auctions.redigeret_kl: den version af auktionen, byderen ser.
  redigeretKl: string | null;
  initialSlutterKl: string;
  initialBud: BidPanelBud[];
  // Mit eget maksimum (automatisk bud) - kun hentet for byderen selv.
  mitMaksimum?: number | null;
  brugerId: string | null;
  saelgerId: string;
  forsendelseMulig: boolean;
  status: string;
  // Anonym vinderbetegnelse fra serveren ("Dig" / "Byder 2") - aldrig navn/id.
  vinderVisning: string | null;
  // Skjult af BidHamr: ingen budknap.
  skjult?: boolean;
  // Skjult og på pause (auctions.pauset_kl): ingen nedtælling - den
  // resterende tid vises i stedet, og auktionen slutter ikke.
  pauset?: boolean;
  // auctions.pause_resterende (Postgres-interval som tekst).
  pauseResterende?: string | null;
}) {
  const [nuværendeBud, setNuværendeBud] = useState(initialNuværendeBud);
  const [harBud, setHarBud] = useState(initialHarBud);
  if (initialHarBud && !harBud) setHarBud(true);
  // Versionen følger serveren (router.refresh() efter en redigering).
  const redigeretKl = initialRedigeretKl;
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
  // Automatisk bud: brugeren skriver sit maksimum i stedet for et bud.
  // Har brugeren allerede et maksimum, åbnes panelet i den tilstand.
  const [automatisk, setAutomatisk] = useState(mitMaksimum !== null);
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Kvittering efter et automatisk bud (fører / overbudt / gemt).
  const [kvittering, setKvittering] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<string>("aktiv");
  // Skjult af BidHamr (kun sælger, deltagere og staff ser siden): der kan
  // ikke bydes, selvom auktionen stadig står som aktiv.
  const auktionStatus = skjult && status === "aktiv" ? "skjult" : status !== "aktiv" ? status : realtimeStatus;
  // Nedtællingen afhænger af klokken og beregnes først efter mount, så
  // server- og klient-render er ens (ingen hydration-mismatch).
  const [nedtælling, setNedtælling] = useState<string | null>(null);
  // Under en time tilbage: timeren bliver orange (DESIGN.md 1.5).
  const [slutterSnart, setSlutterSnart] = useState(false);

  // Sælgere må ikke byde på egen auktion - databasen afviser det også.
  const erSælger = Boolean(brugerId && brugerId === saelgerId);

  const nuværendeBudRef = useRef(nuværendeBud);
  useEffect(() => {
    nuværendeBudRef.current = nuværendeBud;
  }, [nuværendeBud]);
  const redigeretKlRef = useRef(redigeretKl);
  useEffect(() => {
    redigeretKlRef.current = redigeretKl;
  }, [redigeretKl]);

  // Sættes når nedtællingen er kørt i nul, så genindlæsningen kun sker én
  // gang - også selv om auktionen forlænges og tælleren starter forfra.
  const harLukketRef = useRef(false);
  const senderRef = useRef(false);

  useEffect(() => {
    // På pause: sluttiden gælder ikke, så ingen nedtælling og ingen
    // genindlæsning, når den oprindelige sluttid passeres.
    if (pauset) return;
    const opdater = () => {
      setNedtælling(formatNedtælling(slutterKl));
      const tilbage = new Date(slutterKl).getTime() - Date.now();
      setSlutterSnart(tilbage > 0 && tilbage < 60 * 60 * 1000);
    };
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
  }, [slutterKl, router, pauset]);

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
            redigeret_kl?: string | null;
          };
          if (
            opdateret["nuværende_bud"] != null &&
            opdateret["nuværende_bud"] !== nuværendeBudRef.current
          ) {
            setNuværendeBud(opdateret["nuværende_bud"]);
            setHarBud(true);
            router.refresh();
          }
          // Sælgeren har redigeret auktionen (kun muligt før første bud):
          // hent det nye indhold, så ingen byder på en forældet visning.
          if (
            opdateret.redigeret_kl &&
            redigeretKlRef.current &&
            new Date(opdateret.redigeret_kl).getTime() !==
              new Date(redigeretKlRef.current).getTime()
          ) {
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

  // Første bud må være lig startprisen; derefter budstigning som trappe
  // (samme regel som public.naeste_bud_minimum i databasen).
  const minimumBud = mindsteNaesteBud(harBud ? nuværendeBud : null, startpris);

  // Fører jeg? Budhistorikken er sorteret med det højeste bud først.
  const jegFoerer = harBud && budListe.length > 0 && budListe[0].erMig;
  const harBudtSelv = budListe.some((b) => b.erMig);
  // Maksimum: fører jeg, må det ikke være under mit nuværende bud; ellers
  // skal det mindst være næste mindstebud (samme regel som saet_maksimum).
  const mindsteMaks = jegFoerer ? nuværendeBud : minimumBud;
  const mindsteGyldige = automatisk ? mindsteMaks : minimumBud;
  const maksAktivt = mitMaksimum !== null && jegFoerer && mitMaksimum > nuværendeBud;

  // Kun visning: hvad vinderen kommer til at betale. Det endelige beløb
  // beregnes på serveren, når auktionen slutter.
  const budTal = Number(beløb);
  const estimatOere =
    Number.isFinite(budTal) && budTal >= mindsteGyldige
      ? (() => {
          const budOere = Math.round(budTal * 100);
          return (
            totalOere(
              {
                bud_oere: budOere,
                koebergebyr_oere: Math.round((budOere * KOEBERGEBYR_PROCENT) / 100),
                fragt_oere: fragtOere(forsendelseMulig),
              },
              beskyttelse && forsendelseMulig,
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
    setKvittering(null);
    // Ref-lås: loading-state fra en gammel closure stopper ikke to indsendelser
    // i samme tick (det andet bud fik ellers en vildledende minimumsfejl).
    if (senderRef.current) return;
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

    if (automatisk) {
      if (!Number.isFinite(beløbTal) || !Number.isInteger(beløbTal) || beløbTal < mindsteMaks) {
        setError(
          jegFoerer
            ? `Du fører med ${nuværendeBud.toLocaleString("da-DK")} kr. Dit maksimum kan ikke være lavere end dit nuværende bud.`
            : `Dit maksimum skal være mindst ${mindsteMaks.toLocaleString("da-DK")} kr.`,
        );
        return;
      }
      setLoading(true);
      senderRef.current = true;
      let maksSvar: Awaited<ReturnType<typeof saetMaksimum>>;
      try {
        maksSvar = await saetMaksimum(
          auktionId,
          beløbTal,
          beskyttelse && forsendelseMulig,
          redigeretKl,
        );
      } finally {
        senderRef.current = false;
      }
      setLoading(false);
      if ("fejl" in maksSvar) {
        setError(maksSvar.fejl);
        if (maksSvar.auktionAendret) router.refresh();
        return;
      }
      const kr = (n: number) => `${n.toLocaleString("da-DK")} kr`;
      if (maksSvar.nuvaerendeBud !== null) {
        setNuværendeBud(maksSvar.nuvaerendeBud);
        setHarBud(true);
      }
      setKvittering(
        !maksSvar.budAfgivet
          ? AUTOBUD.svarGemt(kr(maksSvar.maks))
          : maksSvar.foerer
            ? AUTOBUD.svarFoerer(kr(maksSvar.nuvaerendeBud ?? beløbTal), kr(maksSvar.maks))
            : AUTOBUD.svarOverbudt(kr(maksSvar.nuvaerendeBud ?? beløbTal)),
      );
      setTimeout(() => setKvittering(null), 8000);
      if (
        maksSvar.slutterKl &&
        new Date(maksSvar.slutterKl).getTime() > new Date(slutterKl).getTime()
      ) {
        setSlutterKl(maksSvar.slutterKl);
      }
      setBeløb("");
      router.refresh();
      return;
    }

    if (!Number.isFinite(beløbTal) || !Number.isInteger(beløbTal) || beløbTal < minimumBud) {
      setError(
        harBud
          ? `Dit bud skal være mindst ${minimumBud.toLocaleString("da-DK")} kr.`
          : `Dit bud skal være mindst ${minimumBud.toLocaleString("da-DK")} kr (startprisen).`,
      );
      return;
    }

    setLoading(true);
    senderRef.current = true;

    // Afgives paa serveren (rate limit). RLS og triggere gaelder uaendret.
    // Kun afhentning: BidHamr Beskyttelse kan ikke tilvælges (afhentningshandler
    // kan ikke få sager). Databasen tvinger det også til nej.
    let svar: Awaited<ReturnType<typeof afgivBud>>;
    try {
      svar = await afgivBud(
        auktionId,
        beløbTal,
        beskyttelse && forsendelseMulig,
        redigeretKl,
      );
    } finally {
      senderRef.current = false;
    }

    if ("fejl" in svar) {
      setLoading(false);
      setError(svar.fejl);
      if (svar.auktionAendret) router.refresh();
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

  // Budbjælken på mobil: vises i bunden af siden (#byd-bjaelke på
  // auktionssiden), når selve budboksen er rullet ud af syne.
  const panelRef = useRef<HTMLDivElement>(null);
  const budFeltRef = useRef<HTMLInputElement>(null);
  const [panelSynligt, setPanelSynligt] = useState(true);
  const [bjaelkeMaal, setBjaelkeMaal] = useState<HTMLElement | null>(null);
  // Prisen og budknappen holdes øje med: er en af dem synlig, skjules bjælken.
  const prisRef = useRef<HTMLDivElement>(null);
  const handlingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const maal = [prisRef.current, handlingRef.current].filter(
      (el): el is HTMLDivElement => el !== null,
    );
    if (maal.length === 0 || typeof IntersectionObserver === "undefined") return;
    const synlige = new Set<Element>();
    const observer = new IntersectionObserver((indgange) => {
      for (const i of indgange) {
        if (i.isIntersecting) synlige.add(i.target);
        else synlige.delete(i.target);
      }
      setBjaelkeMaal(document.getElementById("byd-bjaelke"));
      setPanelSynligt(synlige.size > 0);
    });
    maal.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const visteBud = visAlle ? budListe : budListe.slice(0, VIST_SOM_STANDARD);
  const visningsBud = harBud ? nuværendeBud : startpris;
  const kanByde = auktionStatus === "aktiv" && !erSælger;

  // Opsummering før "Afgiv bud" (DESIGN.md 8.6): bud, gebyr og fragt på hver
  // sin linje og totalen nederst. Kun visning - serveren beregner beløbet.
  const gyldigtBud = estimatOere !== null;
  const budOereVist = gyldigtBud ? Math.round(budTal * 100) : null;
  const gebyrOereVist =
    budOereVist !== null ? Math.round((budOereVist * KOEBERGEBYR_PROCENT) / 100) : null;
  const beskyttelseVist = beskyttelse && forsendelseMulig && budOereVist !== null
    ? beskyttelseOere(budOereVist)
    : null;

  // Hvad det mindste bud koster i alt - vises i budbjælken på mobil.
  const mindsteTotalOere = (() => {
    const budOere = Math.round(minimumBud * 100);
    return totalOere(
      {
        bud_oere: budOere,
        koebergebyr_oere: Math.round((budOere * KOEBERGEBYR_PROCENT) / 100),
        fragt_oere: fragtOere(forsendelseMulig),
      },
      false,
    );
  })();

  function gaaTilBud() {
    const panel = panelRef.current;
    if (!panel) return;
    const reduceret = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView({ behavior: reduceret ? "auto" : "smooth", block: "start" });
    // Fokus uden at rulle igen, så tastaturet åbner på budfeltet.
    budFeltRef.current?.focus({ preventScroll: true });
  }

  const linje = "flex items-baseline justify-between gap-3";

  return (
    <div ref={panelRef} className="scroll-mt-4 rounded-[14px] border border-kant bg-white p-4 sm:p-5">
      {/* Afslutning + countdown. En annulleret auktion slutter ikke - kun
          status vises (længere nede). */}
      {auktionStatus === "annulleret" ? null : pauset ? (
        <p className="inline-flex items-center gap-1.5 rounded-full bg-advarsel-bg px-3 py-1 text-[13px] font-semibold text-advarsel-tekst tabular-nums">
          <Ikon navn="ur" className="h-4 w-4" strøg={2} />
          {pauseTekst(pauseResterende)}
        </p>
      ) : (
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-sm text-tekst-daempet">
          Afsluttes{" "}
          {new Date(slutterKl).toLocaleString("da-DK", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
        <p
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold tabular-nums ${
            slutterSnart && auktionStatus === "aktiv" ? "bg-orange-knap text-white" : "bg-groen-lys text-groen-mork"
          }`}
        >
          <Ikon navn="ur" className="h-4 w-4" strøg={2} />
          {slutterSnart && auktionStatus === "aktiv" && <span className="sr-only">Slutter snart: </span>}
          {nedtælling ?? "–"}
        </p>
      </div>
      )}

      {auktionStatus !== "annulleret" && <div className="my-4 border-t border-kant" />}

      {/* Førende bud */}
      <div ref={prisRef}>
        <p className="text-[13px] font-medium text-tekst-svag">
          {harBud ? "Førende bud" : "Startpris"}
        </p>
        <p className="mt-0.5 text-[26px] leading-tight font-bold text-tekst tabular-nums lg:text-[30px]">
          {visningsBud.toLocaleString("da-DK")} kr
        </p>
      </div>

      {/* Min status: fører / overbudt - og mit eget maksimum (kun mig). */}
      {kanByde && brugerId && harBudtSelv && (
        <div
          role="status"
          className={`mt-3 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${
            jegFoerer
              ? "border-succes-kant bg-succes-bg text-succes-tekst"
              : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"
          }`}
        >
          <Ikon navn={jegFoerer ? "flueben" : "ur"} className="mt-0.5 h-4 w-4 shrink-0" strøg={2} />
          <div className="min-w-0">
            <p className="font-semibold">{jegFoerer ? AUTOBUD.statusFoerer : AUTOBUD.statusOverbudt}</p>
            {jegFoerer && maksAktivt && mitMaksimum !== null && (
              <p className="mt-0.5">{AUTOBUD.statusFoererMedMaks(`${mitMaksimum.toLocaleString("da-DK")} kr`)}</p>
            )}
            {!jegFoerer && mitMaksimum !== null && (
              <p className="mt-0.5">{AUTOBUD.statusMaksNaaet(`${mitMaksimum.toLocaleString("da-DK")} kr`)}</p>
            )}
          </div>
        </div>
      )}

      {auktionStatus !== "aktiv" ? (
        <div className="mt-4 rounded-xl bg-groen-lys px-5 py-4 text-center">
          {auktionStatus === "afsluttet" ? (
            <>
              <p className="text-base font-semibold text-groen-mork">Auktionen er afsluttet</p>
              {vinderVisning ? (
                <p className="mt-1 text-sm text-tekst-daempet">
                  Vinder: <span className="font-semibold text-tekst">{vinderVisning}</span>
                </p>
              ) : null}
            </>
          ) : auktionStatus === "annulleret" ? (
            <p className="text-base font-semibold text-tekst-daempet">Auktionen er annulleret</p>
          ) : auktionStatus === "skjult" && pauset ? (
            <>
              <p className="text-base font-semibold text-tekst-daempet">Auktionen er sat på pause</p>
              <p className="mt-1 text-sm text-tekst-daempet">
                BidHamr kigger på den. Der kan ikke bydes imens, og den slutter ikke. Eksisterende bud gælder stadig.
              </p>
            </>
          ) : auktionStatus === "skjult" ? (
            <p className="text-base font-semibold text-tekst-daempet">Der kan ikke bydes, mens auktionen er skjult</p>
          ) : (
            <p className="text-base font-semibold text-tekst-daempet">Ingen bud – auktionen er lukket</p>
          )}
        </div>
      ) : erSælger ? (
        <p className="mt-4 rounded-xl bg-groen-lys px-4 py-3 text-center text-sm text-groen-mork">
          Det er din egen auktion – du kan ikke byde på den.
        </p>
      ) : brugerId ? (
        <form onSubmit={handleSubmit} noValidate className="mt-4 flex flex-col gap-3">
          {/* Budtype: ét bud eller automatisk bud op til et maksimum. */}
          <div
            role="radiogroup"
            aria-label="Budtype"
            className="grid grid-cols-2 gap-1 rounded-xl bg-groen-lys p-1"
          >
            {([
              [false, AUTOBUD.valgEnkelt],
              [true, AUTOBUD.valgAutomatisk],
            ] as const).map(([vaerdi, tekst]) => {
              const valgt = automatisk === vaerdi;
              return (
                <button
                  key={tekst}
                  type="button"
                  role="radio"
                  aria-checked={valgt}
                  onClick={() => {
                    setAutomatisk(vaerdi);
                    setError(null);
                  }}
                  className={`min-h-11 rounded-lg px-2 text-sm font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                    valgt ? "bg-white text-groen-mork shadow-sm" : "text-tekst-daempet hover:text-tekst"
                  }`}
                >
                  {tekst}
                </button>
              );
            })}
          </div>

          <div>
            <label htmlFor={`bud-${auktionId}`} className="mb-1.5 block text-sm font-medium text-tekst">
              {automatisk ? AUTOBUD.feltLabel : "Dit bud"}
            </label>
            <div className="relative">
              <input
                id={`bud-${auktionId}`}
                ref={budFeltRef}
                type="number"
                inputMode="numeric"
                min={mindsteGyldige}
                step={1}
                value={beløb}
                onChange={(e) => setBeløb(e.target.value)}
                placeholder={
                  automatisk && maksAktivt && mitMaksimum !== null
                    ? `Nu ${mitMaksimum.toLocaleString("da-DK")}`
                    : `Mindst ${mindsteGyldige.toLocaleString("da-DK")}`
                }
                aria-describedby={`bud-${auktionId}-hjaelp`}
                aria-invalid={error ? true : undefined}
                className={`h-[52px] w-full rounded-xl border bg-white pr-12 pl-4 text-lg font-semibold text-tekst tabular-nums placeholder:font-normal placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25 ${
                  error ? "border-fejl-kant bg-fejl-bg/40" : "border-kant-staerk"
                }`}
              />
              <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-[15px] text-tekst-svag">
                kr
              </span>
            </div>
            <p id={`bud-${auktionId}-hjaelp`} className="mt-1.5 text-[13px] text-tekst-daempet">
              {automatisk ? (
                <>
                  {AUTOBUD.feltHjaelp}{" "}
                  {jegFoerer
                    ? `Du fører, så det kan ikke være lavere end dit nuværende bud på ${mindsteMaks.toLocaleString("da-DK")} kr.`
                    : `Mindst ${mindsteMaks.toLocaleString("da-DK")} kr.`}
                </>
              ) : (
                <>Mindste bud er {minimumBud.toLocaleString("da-DK")} kr.</>
              )}
            </p>
          </div>

          {automatisk && (
            <details className="group rounded-xl border border-info-kant bg-info-bg text-sm text-info-tekst">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3.5 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 16v-4m0-4h.01" />
                  </svg>
                  {AUTOBUD.forklaringTitel}
                </span>
                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 transition-transform duration-150 group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
                </svg>
              </summary>
              <ul className="flex list-disc flex-col gap-1.5 px-3.5 pt-0.5 pb-3 pl-8 leading-relaxed">
                {AUTOBUD.forklaring.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </details>
          )}

          {forsendelseMulig && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 rounded-xl border border-kant bg-white px-3">
            <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-3 py-2">
              <input
                type="checkbox"
                checked={beskyttelse}
                onChange={(e) => setBeskyttelse(e.target.checked)}
                className="h-5 w-5 shrink-0 accent-groen"
              />
              <span className="flex items-center gap-1.5 text-sm font-semibold text-tekst">
                <Ikon navn="skjold" className="h-[18px] w-[18px] shrink-0 text-groen" />
                <span>
                  {BIDPANEL.beskyttelseLabel}
                  {beskyttelsePrisOere !== null && (
                    <span className="ml-1 font-normal text-tekst-daempet">
                      + {kroner(beskyttelsePrisOere)}
                    </span>
                  )}
                </span>
              </span>
            </label>
            {/* Uden for label, så et klik ikke slår afkrydsningen til/fra. */}
            <Link
              href={BIDPANEL.laesMereHref}
              className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-groen underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              {BIDPANEL.laesMere}
            </Link>
          </div>
          )}

          {/* Totalpris før man byder (bud + gebyr + fragt) */}
          <div className="rounded-xl bg-groen-lys p-4" aria-live="polite">
            <dl className="flex flex-col gap-1 text-sm text-tekst-daempet">
              <div className={linje}>
                <dt>{automatisk ? AUTOBUD.feltLabel : "Dit bud"}</dt>
                <dd className="tabular-nums">{budOereVist !== null ? kroner(budOereVist) : "–"}</dd>
              </div>
              <div className={linje}>
                <dt>Købergebyr</dt>
                <dd className="tabular-nums">{gebyrOereVist !== null ? kroner(gebyrOereVist) : "–"}</dd>
              </div>
              <div className={linje}>
                <dt>{forsendelseMulig ? "Fragt" : "Fragt (kun afhentning)"}</dt>
                <dd className="tabular-nums">{kroner(fragtOere(forsendelseMulig))}</dd>
              </div>
              {beskyttelseVist !== null && (
                <div className={linje}>
                  <dt>BidHamr Beskyttelse</dt>
                  <dd className="tabular-nums">{kroner(beskyttelseVist)}</dd>
                </div>
              )}
              <div className={`${linje} mt-2 border-t border-groen/20 pt-2`}>
                <dt className="font-semibold text-tekst">
                  {automatisk ? AUTOBUD.totalLabel : "Du betaler i alt, hvis du vinder"}
                </dt>
                <dd className="shrink-0 text-lg font-bold whitespace-nowrap text-tekst tabular-nums">
                  {estimatOere !== null ? kroner(estimatOere) : "–"}
                </dd>
              </div>
            </dl>
          </div>

          <div ref={handlingRef} className="flex flex-col gap-2">
            <button
              type="submit"
              disabled={loading || !gyldigtBud}
              aria-busy={loading || undefined}
              className="btn btn-primaer btn-stor w-full"
            >
              {loading && <span className="btn-spinner" aria-hidden="true" />}
              {automatisk ? (maksAktivt ? AUTOBUD.knapRet : AUTOBUD.knapNy) : "Afgiv bud"}
            </button>
            {!gyldigtBud && (
              <p className="text-center text-[13px] text-tekst-daempet">
                {automatisk
                  ? "Skriv dit maksimum for at se, hvad du højst kan komme til at betale."
                  : "Skriv dit bud for at se den samlede pris."}
              </p>
            )}
          </div>

          <p className="flex items-start gap-2 rounded-xl border border-advarsel-kant bg-advarsel-bg px-3 py-2.5 text-[13px] font-medium text-advarsel-tekst">
            <svg viewBox="0 0 24 24" className="mt-px h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 8v4m0 4h.01" />
            </svg>
            {automatisk ? AUTOBUD.bindende : BINDENDE_BUD_TEKST}
          </p>
        </form>
      ) : (
        <div ref={handlingRef} className="mt-4">
          <Link
            href={`/login?redirect=${encodeURIComponent(`/auktion/${auktionId}`)}`}
            className="btn btn-primaer btn-stor w-full"
          >
            Log ind for at byde
          </Link>
        </div>
      )}

      <p className="mt-3 text-[13px] leading-relaxed text-tekst-daempet">
        {BIDPANEL.prisLinje}
      </p>
      {!forsendelseMulig && (
        <p className="mt-1 text-[13px] text-tekst-daempet">
          Kun afhentning – ingen fragt.
        </p>
      )}

      {info && (
        <div role="status" className="mt-3 flex items-center gap-2 rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 8v4m0 4h.01" />
          </svg>
          {info}
        </div>
      )}

      {kvittering && (
        <div role="status" className="mt-3 flex items-start gap-2 rounded-xl border border-succes-kant bg-succes-bg px-4 py-3 text-sm text-succes-tekst">
          <Ikon navn="flueben" className="mt-0.5 h-4 w-4 shrink-0" strøg={2} />
          {kvittering}
        </div>
      )}

      {error && (
        <div role="alert" className="mt-3 rounded-xl border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
          {error}
        </div>
      )}

      {auktionStatus !== "annulleret" && <div className="my-4 border-t border-kant" />}

      {/* Budhistorik */}
      <h2 className="text-[17px] leading-snug lg:text-lg">Budhistorik</h2>

      {budListe.length === 0 ? (
        <p className="mt-2 text-sm text-tekst-svag">
          Ingen bud endnu – vær den første.
        </p>
      ) : (
        <>
          <table className="mt-3 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-kant text-xs text-tekst-svag">
                <th scope="col" className="py-2 font-medium">Bud</th>
                <th scope="col" className="py-2 font-medium">Tidspunkt</th>
                <th scope="col" className="py-2 text-right font-medium">Budgiver</th>
              </tr>
            </thead>
            <tbody>
              {visteBud.map((bud, index) => {
                const fed = index === 0 ? "font-bold text-tekst" : "text-tekst-daempet";
                return (
                  <tr key={bud.id} className="border-b border-kant last:border-b-0">
                    <td className={`py-2 tabular-nums ${fed}`}>
                      {bud.beløb.toLocaleString("da-DK")} kr
                    </td>
                    <td className={`py-2 tabular-nums ${fed}`}>
                      {new Date(bud.oprettet).toLocaleString("da-DK", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className={`py-2 text-right ${fed}`}>
                      {bud.byder}
                      {bud.automatisk && (
                        <span className="mt-0.5 block text-xs font-normal text-tekst-svag">
                          {AUTOBUD.historikMarkering}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {budListe.length > VIST_SOM_STANDARD && (
            <button
              type="button"
              onClick={() => setVisAlle(!visAlle)}
              className="mt-2 inline-flex min-h-11 items-center rounded-md text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              {visAlle ? "Vis færre bud" : "Vis al budhistorik"}
            </button>
          )}
        </>
      )}

      {/* Budbjælke i bunden på mobil, mens budboksen er ude af syne. */}
      {bjaelkeMaal && kanByde &&
        createPortal(
          <div
            className={`border-t border-kant bg-white px-4 py-3 shadow-flyder transition-opacity duration-200 sm:px-6 ${
              panelSynligt ? "pointer-events-none invisible opacity-0" : "opacity-100"
            }`}
            aria-hidden={panelSynligt || undefined}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-tekst-svag">
                  {harBud ? "Førende bud" : "Startpris"}
                  {nedtælling ? <> · {nedtælling}</> : null}
                </p>
                <p className="text-lg leading-tight font-bold text-tekst tabular-nums">
                  {visningsBud.toLocaleString("da-DK")} kr
                </p>
                <p className="truncate text-xs text-tekst-daempet">
                  {brugerId && jegFoerer
                    ? maksAktivt && mitMaksimum !== null
                      ? `Du fører · dit maksimum ${mitMaksimum.toLocaleString("da-DK")} kr`
                      : "Du fører"
                    : brugerId && harBudtSelv
                      ? "Du er overbudt"
                      : `Fra ${kroner(mindsteTotalOere)} i alt inkl. gebyr og fragt`}
                </p>
              </div>
              {brugerId ? (
                <button
                  type="button"
                  onClick={gaaTilBud}
                  tabIndex={panelSynligt ? -1 : undefined}
                  className="btn btn-primaer shrink-0"
                >
                  Afgiv bud
                </button>
              ) : (
                <Link
                  href={`/login?redirect=${encodeURIComponent(`/auktion/${auktionId}`)}`}
                  tabIndex={panelSynligt ? -1 : undefined}
                  className="btn btn-primaer shrink-0"
                >
                  Log ind for at byde
                </Link>
              )}
            </div>
          </div>,
          bjaelkeMaal,
        )}
    </div>
  );
}
