"use client";

// "Send varen retur" i en sag (køberen) - kun når FRAGT_RETURLABEL_AKTIV=true
// (tjekkes på serveren i HandelDetalje og i returfragt.ts).
//
// Køberen betaler selv returfragten (Filip, 13. okt. 2026) på en lille
// checkout her: adresse + mobil (til labelen) og Stripes Payment Element.
// Fragtfirmaet er det samme som pakken ud (Shipmondo: DAO-kode, PostNord- og
// GLS-QR-kode - se src/lib/fragt/shipmondo.ts). Returkoden laves
// og vises FØRST, når Stripe har bekræftet betalingen (webhook). Indtil da
// viser boksen "venter", og siden opdaterer sig selv.
//
// Fejl fra serveren er danske og vises direkte.
import dynamic from "next/dynamic";
import Image from "next/image";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Ikon from "@/components/Ikon";
import SporingTidslinje from "@/components/fragt/SporingTidslinje";
import {
  gemReturAfsenderAction,
  hentFragtlabelLink,
  lavReturlabelAction,
  soegPakkeshopsAction,
  startReturfragtAction,
} from "@/app/actions/fragt";
import type { ForsendelseVisning } from "@/lib/fragt/handlinger";
import { TRANSPORTOER_INFO, erTransportoer, type Pakkeshop, type TransportoerInfo } from "@/lib/fragt/types";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { kroner } from "@/lib/kroner";
import { useHydreret } from "@/lib/useHydreret";

const ReturfragtBetaling = dynamic(() => import("@/components/fragt/ReturfragtBetaling"), {
  ssr: false,
  loading: () => <div className="mt-5 h-40 animate-pulse rounded-xl bg-groen-lys" aria-hidden="true" />,
});

export type Afsender = { navn: string; adresse: string; postnummer: string; by: string; telefon: string };
type FeltFejl = Partial<Record<keyof Afsender, string>>;

// Det, serveren ved om køberens returfragt (min_returfragt i databasen).
export type ReturfragtVisning = {
  status: "afventer" | "behandles" | "betalt" | "refunderes" | "refunderet" | "annulleret" | null;
  beloebOere: number | null;
  labelFejl: string | null;
  // Returkoden er annulleret, men fragtfirmaet har ikke bekræftet det.
  labelAnnulleret: boolean;
  refusionAarsag: string | null;
  // Sagen tillader, at varen sendes nu (ankefristen er udløbet osv.).
  kanSende: boolean;
};

const feltKlasse = (fejl: boolean) =>
  `h-11 w-full rounded-xl border bg-white px-4 text-[15px] text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25 disabled:cursor-not-allowed disabled:bg-[#F7F7F7] ${
    fejl ? "border-fejl-kant bg-fejl-bg/40" : "border-kant-staerk hover:border-[#BFBFBF]"
  }`;

function valider(a: Afsender): FeltFejl {
  const f: FeltFejl = {};
  if (a.navn.trim().length < 2) f.navn = "Skriv dit fulde navn.";
  if (a.adresse.trim().length < 3) f.adresse = "Skriv vejnavn og husnummer.";
  if (!slaaPostnummerOp(a.postnummer)) f.postnummer = "Skriv et gyldigt dansk postnummer (4 cifre).";
  if (!a.by.trim()) f.by = "Skriv byen.";
  const tlf = a.telefon.replace(/[\s().-]/g, "");
  if (!/^(\d{8}|(\+|00)\d{8,14})$/.test(tlf)) f.telefon = "Skriv dit mobilnummer (8 cifre).";
  return f;
}

// Opdaterer siden med jævne mellemrum, mens vi venter på Stripe/fragtfirmaet.
function useAutoOpdater(aktiv: boolean, intervalMs = 4000, maks = 45) {
  const router = useRouter();
  useEffect(() => {
    if (!aktiv) return;
    let n = 0;
    const t = setInterval(() => {
      n++;
      if (n > maks) clearInterval(t);
      else router.refresh();
    }, intervalMs);
    return () => clearInterval(t);
  }, [aktiv, intervalMs, maks, router]);
}

function FejlBoks({ fejl }: { fejl: string | null }) {
  if (!fejl) return null;
  return (
    <div role="alert" className="mt-4 rounded-xl border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
      {fejl}
    </div>
  );
}

function AdresseFelter({
  id,
  a,
  saet,
  feltFejl,
  laast,
}: {
  id: string;
  a: Afsender;
  saet: (k: keyof Afsender, v: string) => void;
  feltFejl: FeltFejl;
  laast: boolean;
}) {
  return (
    <fieldset className="min-w-0" disabled={laast}>
      <legend className="mb-2 text-sm font-medium text-tekst">Din adresse (afsender)</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ["navn", "Fulde navn", "name", "sm:col-span-2"],
            ["adresse", "Adresse", "street-address", "sm:col-span-2"],
            ["postnummer", "Postnummer", "postal-code", ""],
            ["by", "By", "address-level2", ""],
            ["telefon", "Mobilnummer", "tel", "sm:col-span-2"],
          ] as const
        ).map(([k, label, auto, kl]) => (
          <div key={k} className={kl}>
            <label htmlFor={`${id}-${k}`} className="mb-1.5 block text-sm font-medium text-tekst">
              {label}
            </label>
            <input
              id={`${id}-${k}`}
              aria-invalid={feltFejl[k] ? true : undefined}
              aria-describedby={feltFejl[k] ? `${id}-${k}-fejl` : undefined}
              autoComplete={auto}
              inputMode={k === "postnummer" ? "numeric" : k === "telefon" ? "tel" : undefined}
              type={k === "telefon" ? "tel" : "text"}
              maxLength={k === "postnummer" ? 4 : k === "telefon" ? 20 : k === "by" ? 80 : 100}
              value={a[k]}
              onChange={(e) => saet(k, k === "postnummer" ? e.target.value.replace(/\D/g, "").slice(0, 4) : e.target.value)}
              className={feltKlasse(!!feltFejl[k])}
            />
            {feltFejl[k] && (
              <p id={`${id}-${k}-fejl`} className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
                {feltFejl[k]}
              </p>
            )}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function useAfsender(start: Afsender) {
  const [a, setA] = useState<Afsender>(start);
  const [feltFejl, setFeltFejl] = useState<FeltFejl>({});
  const saet = useCallback((k: keyof Afsender, v: string) => {
    setA((x) => {
      const ny = { ...x, [k]: v };
      if (k === "postnummer") {
        const o = slaaPostnummerOp(v);
        if (o && (!x.by || slaaPostnummerOp(x.postnummer)?.by === x.by)) ny.by = o.by;
      }
      return ny;
    });
    setFeltFejl((f) => (f[k] ? { ...f, [k]: undefined } : f));
  }, []);
  return { a, saet, feltFejl, setFeltFejl };
}

export default function ReturlabelBoks({
  tradeId,
  retur,
  info,
  afsender,
  venterPaaBekraeftelse,
  transportoer = null,
}: {
  tradeId: string;
  // Fragtfirmaet (samme som pakken ud). null = DAO-teksterne.
  transportoer?: string | null;
  // Den aktive returforsendelse (ikke annulleret), eller null.
  retur: ForsendelseVisning | null;
  info: ReturfragtVisning;
  // Forudfyldning (gemt adresse eller profilens navn).
  afsender: Afsender;
  // Køberen er lige vendt tilbage fra betalingen (?returfragt=retur).
  venterPaaBekraeftelse: boolean;
}) {
  const id = useId();
  const betalt = info.status === "betalt" || info.status === "refunderes";
  const labelKlar = !!retur && retur.status !== "opretter" && retur.status !== "annulleres" && retur.status !== "fejlet";
  const behandles = info.status === "behandles" || (venterPaaBekraeftelse && info.status === "afventer");
  const venterPaaKode = info.status === "betalt" && !labelKlar && !info.labelFejl && !info.labelAnnulleret;
  useAutoOpdater(behandles || venterPaaKode);
  const t = retur?.transportoer ?? transportoer;
  const firma = erTransportoer(t) ? t : null;

  if (labelKlar && retur) {
    return <KodeKlar id={id} retur={retur} postnummer={afsender.postnummer} firmaInfo={firmaInfo(t)} firma={firma} />;
  }

  if (info.status === "refunderes") {
    return (
      <Boks id={id} titel="Returfragten sendes tilbage">
        <p className="mt-1 text-sm text-tekst-svag">
          Returkoden kunne ikke laves, så vi sender returfragten tilbage til dig. Du skal ikke gøre noget. Skriv til
          BidHamr i sagen, så hjælper vi dig med at sende varen.
        </p>
      </Boks>
    );
  }

  if (betalt) {
    return (
      <Boks id={id} titel="Send varen retur">
        <p className="mt-1 text-sm text-groen-mork">
          Tak – returfragten {info.beloebOere ? `(${kroner(info.beloebOere)}) ` : ""}er betalt. Du skal ikke betale igen.
        </p>
        {info.labelAnnulleret ? (
          <p className="mt-3 rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
            Din returkode er annulleret. BidHamr kigger på returen og skriver til dig i sagen. Du skal ikke betale igen.
          </p>
        ) : info.labelFejl ? (
          <ProevIgen tradeId={tradeId} fejl={info.labelFejl} start={afsender} />
        ) : (
          <p role="status" className="mt-3 flex items-center gap-2 rounded-xl border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
            <span className="btn-spinner" aria-hidden="true" />
            Vi laver din returkode. Det tager normalt under et minut – siden opdaterer sig selv.
          </p>
        )}
      </Boks>
    );
  }

  if (behandles) {
    return (
      <Boks id={id} titel="Send varen retur">
        <p role="status" className="mt-3 flex items-center gap-2 rounded-xl border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
          <span className="btn-spinner" aria-hidden="true" />
          Vi venter på bekræftelse af din betaling. Når den er på plads, laver vi din returkode – siden opdaterer sig
          selv.
        </p>
      </Boks>
    );
  }

  if (!info.kanSende || !info.beloebOere) return null;
  return (
    <BetalReturfragt
      id={id}
      tradeId={tradeId}
      beloebOere={info.beloebOere}
      start={afsender}
      refunderet={info.status === "refunderet"}
      firmaInfo={firmaInfo(t)}
    />
  );
}

function firmaInfo(t: string | null | undefined): TransportoerInfo {
  return erTransportoer(t) ? TRANSPORTOER_INFO[t] : TRANSPORTOER_INFO.dao;
}

// Hvordan køberen afleverer returen, og hvor den ender.
function returTekst(f: TransportoerInfo): string {
  const aflever =
    f.returLabelfri === "qr"
      ? `en QR-kode, som du viser i en ${f.shopNavn}, når du afleverer pakken`
      : f.returLabelfri === "kode"
        ? `en kode, som du viser i en ${f.shopNavn}, når du afleverer pakken`
        : `en label, som du printer og sætter på pakken, før du afleverer den i en ${f.shopNavn}`;
  const til = f === TRANSPORTOER_INFO.gls ? "Pakken sendes til sælgerens adresse." : "Pakken sendes til en pakkeshop tæt på sælgeren.";
  return `Når betalingen er gennemført, får du ${aflever}. ${til}`;
}

function Boks({ id, titel, children }: { id: string; titel: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-titel`} className="rounded-none border border-kant bg-white p-5 sm:p-6">
      <h2 id={`${id}-titel`} className="text-[17px] leading-snug lg:text-lg">
        {titel}
      </h2>
      {children}
    </section>
  );
}

// Før betaling: pris, adresse og Payment Element.
function BetalReturfragt({
  id,
  tradeId,
  beloebOere,
  start,
  refunderet,
  firmaInfo: f,
}: {
  id: string;
  tradeId: string;
  beloebOere: number;
  start: Afsender;
  refunderet: boolean;
  firmaInfo: TransportoerInfo;
}) {
  const router = useRouter();
  const { a, saet, feltFejl, setFeltFejl } = useAfsender(start);
  const [fejl, setFejl] = useState<string | null>(null);
  const [betaling, setBetaling] = useState<{
    clientSecret: string;
    customerSessionClientSecret: string | null;
    beloebOere: number;
  } | null>(null);
  const [henter, setHenter] = useState(true);
  const igang = useRef(false);
  const aRef = useRef(a);
  useEffect(() => {
    aRef.current = a;
  }, [a]);

  // Sætter først state efter svaret (kaldes også fra effekten ved start).
  const hent = useCallback(async () => {
    const r = await startReturfragtAction(tradeId).catch(() => ({ fejl: "Betalingen kunne ikke startes. Prøv igen om lidt." }));
    if ("fejl" in r) {
      if ("betalt" in r && r.betalt) router.refresh();
      else setFejl(r.fejl);
      setBetaling(null);
    } else {
      setFejl(null);
      setBetaling({ clientSecret: r.clientSecret, customerSessionClientSecret: r.customerSessionClientSecret, beloebOere: r.beloebOere });
    }
  }, [tradeId, router]);

  const autoStartet = useRef(false);
  useEffect(() => {
    if (autoStartet.current) return;
    autoStartet.current = true;
    igang.current = true;
    void hent().finally(() => {
      igang.current = false;
      setHenter(false);
    });
  }, [hent]);

  const proevIgen = useCallback(() => {
    if (igang.current) return;
    igang.current = true;
    setHenter(true);
    setFejl(null);
    void hent().finally(() => {
      igang.current = false;
      setHenter(false);
    });
  }, [hent]);

  const foerBetaling = useCallback(async () => {
    const nu = aRef.current;
    const f = valider(nu);
    setFeltFejl(f);
    const foerste = (Object.keys(f) as (keyof Afsender)[])[0];
    if (foerste) {
      document.getElementById(`${id}-${foerste}`)?.focus();
      return false;
    }
    try {
      const r = await gemReturAfsenderAction(tradeId, nu);
      if ("fejl" in r) {
        setFejl(r.fejl);
        return false;
      }
      return true;
    } catch {
      setFejl("Noget gik galt. Prøv igen om lidt.");
      return false;
    }
  }, [id, tradeId, setFeltFejl]);

  const pris = betaling?.beloebOere ?? beloebOere;

  return (
    <Boks id={id} titel="Send varen retur">
      {refunderet && (
        <p className="mt-2 rounded-xl border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
          Returkoden kunne ikke laves sidst, så du har fået returfragten tilbage. Du kan prøve igen herunder.
        </p>
      )}
      <p className="mt-1 text-sm text-tekst-svag">
        Du betaler selv returfragten: <span className="font-semibold text-tekst">{kroner(pris)}</span>. {returTekst(f)}{" "}
        Returfragten refunderes ikke.
      </p>
      <FejlBoks fejl={fejl} />
      {betaling ? (
        <ReturfragtBetaling
          clientSecret={betaling.clientSecret}
          customerSessionClientSecret={betaling.customerSessionClientSecret}
          tradeId={tradeId}
          beloebOere={pris}
          foerBetaling={foerBetaling}
          onFejl={setFejl}
          onGenstart={proevIgen}
        >
          <AdresseFelter id={id} a={a} saet={saet} feltFejl={feltFejl} laast={false} />
        </ReturfragtBetaling>
      ) : henter ? (
        <div className="mt-5 h-40 animate-pulse rounded-xl bg-groen-lys" aria-hidden="true" />
      ) : (
        <button type="button" onClick={proevIgen} className="btn btn-sekundaer mt-4 w-full sm:w-auto">
          Prøv igen
        </button>
      )}
    </Boks>
  );
}

// Betalt, men fragtfirmaet afviste labelen: ret adressen og prøv igen (gratis).
function ProevIgen({ tradeId, fejl: startFejl, start }: { tradeId: string; fejl: string; start: Afsender }) {
  const id = useId();
  const router = useRouter();
  const hydreret = useHydreret();
  const { a, saet, feltFejl, setFeltFejl } = useAfsender(start);
  const [fejl, setFejl] = useState<string | null>(null);
  const [arbejder, setArbejder] = useState(false);
  const laas = useRef(false);

  async function send() {
    const f = valider(a);
    setFeltFejl(f);
    const foerste = (Object.keys(f) as (keyof Afsender)[])[0];
    if (foerste) {
      document.getElementById(`${id}-${foerste}`)?.focus();
      return;
    }
    if (laas.current) return;
    laas.current = true;
    setArbejder(true);
    setFejl(null);
    try {
      const r = await lavReturlabelAction(tradeId, a);
      if ("fejl" in r) setFejl(r.fejl);
      else router.refresh();
    } catch {
      setFejl("Noget gik galt. Prøv igen om lidt.");
    } finally {
      laas.current = false;
      setArbejder(false);
    }
  }

  return (
    <div className="mt-3">
      <p className="rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
        Returkoden kunne ikke laves endnu: {startFejl} Vi prøver igen automatisk. Er adressen forkert, så ret den og
        prøv igen – det koster ikke noget.
      </p>
      <form
        method="post"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="mt-4"
      >
        <AdresseFelter id={id} a={a} saet={saet} feltFejl={feltFejl} laast={arbejder} />
        <FejlBoks fejl={fejl} />
        <button
          type="submit"
          disabled={arbejder || !hydreret}
          aria-busy={arbejder || undefined}
          className="btn btn-primaer mt-5 w-full sm:w-auto"
        >
          {arbejder && <span className="btn-spinner" aria-hidden="true" />}
          Prøv igen
        </button>
      </form>
    </div>
  );
}

// Efter betaling: koden/QR'en, PDF og den nærmeste pakkeshop (ved køberens
// adresse) hos samme fragtfirma.
function KodeKlar({
  id,
  retur,
  postnummer,
  firmaInfo: f,
  firma,
}: {
  id: string;
  retur: ForsendelseVisning;
  postnummer: string;
  firmaInfo: TransportoerInfo;
  firma: string | null;
}) {
  const [fejl, setFejl] = useState<string | null>(null);
  const [shop, setShop] = useState<Pakkeshop | null>(null);

  useEffect(() => {
    if (!slaaPostnummerOp(postnummer)) return;
    let aktiv = true;
    soegPakkeshopsAction({ postnummer, antal: 1, transportoer: firma, indlevering: true })
      .then((r) => {
        if (aktiv && "ok" in r && r.pakkeshops[0]) setShop(r.pakkeshops[0]);
      })
      .catch(() => {});
    return () => {
      aktiv = false;
    };
  }, [postnummer, firma]);

  async function aabnLabel(fid: string) {
    setFejl(null);
    const vindue = window.open("", "_blank");
    if (vindue) vindue.opener = null;
    try {
      const r = await hentFragtlabelLink(fid);
      if ("fejl" in r) {
        vindue?.close();
        setFejl(r.fejl);
      } else if (vindue) vindue.location.href = r.url;
      else window.location.href = r.url;
    } catch {
      vindue?.close();
      setFejl("Noget gik galt. Prøv igen om lidt.");
    }
  }

  return (
    <Boks id={id} titel="Din returkode er klar">
      {retur.qrBillede && (
        <div className="mt-4 rounded-xl bg-groen-lys p-4 text-center sm:p-5">
          <p className="text-sm font-semibold text-groen-mork">Vis QR-koden i en {f.shopNavn}</p>
          <Image
            src={retur.qrBillede}
            alt={`QR-kode til at aflevere returpakken hos ${f.navn}`}
            width={220}
            height={220}
            unoptimized
            className="mx-auto mt-3 h-[220px] w-[220px] rounded-lg bg-white p-2 [image-rendering:pixelated]"
          />
          <p className="mx-auto mt-2 max-w-[44ch] text-[13px] text-tekst-daempet">
            Du behøver ikke en printer. Vis QR-koden på din mobil, når du afleverer pakken.{" "}
            {f === TRANSPORTOER_INFO.gls ? "Pakken sendes til sælgerens adresse." : "Pakken sendes til en pakkeshop tæt på sælgeren."}
          </p>
        </div>
      )}
      {retur.labelfriKode && !retur.qrBillede && (
        <div className="mt-4 rounded-xl bg-groen-lys p-4 text-center sm:p-5">
          <p className="text-sm font-semibold text-groen-mork">Vis denne kode i en {f.shopNavn}</p>
          <p
            className="mt-2 font-mono text-[28px] leading-tight font-bold tracking-[0.08em] break-all text-tekst sm:text-[34px]"
            aria-label={`Returkode: ${retur.labelfriKode.split("").join(" ")}`}
          >
            {retur.labelfriKode}
          </p>
          <p className="mx-auto mt-2 max-w-[44ch] text-[13px] text-tekst-daempet">
            Du behøver ikke en printer. Vis koden, når du afleverer pakken i en {f.shopNavn}. Pakken sendes til en
            pakkeshop tæt på sælgeren.
          </p>
        </div>
      )}
      {!retur.labelfriKode && !retur.qrBillede && retur.harLabel && (
        <p className="mt-4 rounded-xl bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
          Print labelen, og sæt den på pakken. Aflever pakken i en {f.shopNavn}.
        </p>
      )}
      {shop && (
        <div className="mt-4 rounded-xl border border-kant px-4 py-3 text-sm">
          <p className="font-semibold text-tekst">Nærmeste pakkeshop</p>
          <p className="mt-0.5 text-tekst-daempet">
            {shop.navn}, {shop.adresse}, {shop.postnummer} {shop.by}
          </p>
          <p className="mt-1 text-[13px] text-tekst-svag">Du kan aflevere pakken i alle pakkeshops hos {f.navn}.</p>
        </div>
      )}
      {retur.harLabel && (
        <button type="button" onClick={() => void aabnLabel(retur.id)} className="btn btn-sekundaer mt-4 w-full sm:w-auto">
          <Ikon navn="hent" className="h-[18px] w-[18px]" />
          Hent label (PDF)
        </button>
      )}
      <FejlBoks fejl={fejl} />
      <div className="mt-5 border-t border-kant pt-4">
        <h3 className="mb-3 text-[15px] font-semibold text-tekst">Sporing</h3>
        <SporingTidslinje f={retur} />
      </div>
    </Boks>
  );
}
