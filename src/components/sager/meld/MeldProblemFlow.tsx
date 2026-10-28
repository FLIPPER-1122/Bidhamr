"use client";

// "Meld et problem" i 4 trin (showcase/opret-sag-showcase.html, godkendt af
// Filip 27. okt. 2026): 1. Hvad er der galt? 2. Billeder 3. Fortæl kort
// 4. Tjek og send. Ved "Jeg har ikke fået pakken" springes billederne over.
//
// Alt, køberen må, kommer fra serveren (hentSagMuligheder -> valg): typerne,
// billedkravene, tekstforslagene og "Hvis du får ret". Databasen (sag_opret)
// er den endelige dommer. Teksterne står i src/lib/tekster/sagValg.ts, så
// appen viser det samme.
//
// Trinnet står i adressen (?trin=billeder osv.) via window.history.pushState,
// så browserens tilbage-knap virker uden at hente siden igen - og intet går
// tabt, fordi alt ligger i denne komponent. Billederne uploades først, når
// køberen trykker "Send til BidHamr".
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { opretSag } from "@/app/actions/sager";
import Ikon from "@/components/Ikon";
import { indeholderKontaktinfo } from "@/lib/kontaktInfo";
import type { SagValgMulighed } from "@/lib/sagMuligheder";
import {
  SAG_BESKRIVELSE_MAKS,
  SAG_BESKRIVELSE_MIN,
  SAG_MAKS_BILLEDER,
  SAG_MAKS_BILLEDSTOERRELSE,
  SAG_OPRET_FEJL,
  SAG_SMIDT_UD_BEGRUNDELSE_MAKS,
  SAG_SMIDT_UD_BEGRUNDELSE_MIN,
  SAG_TYPE_NAVN,
  type SagType,
} from "@/lib/sager";
import {
  SAG_BILLEDER_HJAELP,
  SAG_BILLEDER_INTRO,
  SAG_DET_SKER,
  SAG_FLOW,
  SAG_SMIDT_UD,
  SAG_TEKST,
  SAG_VALG,
  sagBilledKrav,
  sagUdfyld,
  type SagBilledKrav,
  type SagValgId,
} from "@/lib/tekster/sagValg";
import { useHydreret } from "@/lib/useHydreret";
import { useFrigivPreviews } from "../BilledVaelger";
import { ACCEPT, UPLOAD_FEJL, filType, uploadBilleder, type ValgtBillede } from "../sagUpload";
import SagEksempel, { eksempelMotiv } from "./SagEksempel";
import SagVareKort, { VareLinje, type SagFristVisning, type SagVare } from "./SagVareKort";
import ValgIkon from "./ValgIkon";

type Trin = "hvad" | "billeder" | "beskriv" | "tjek";
const TRIN: readonly Trin[] = ["hvad", "billeder", "beskriv", "tjek"];
const GENERISK = "Noget gik galt. Prøv igen om lidt.";

function erTrin(v: string | null): v is Trin {
  return !!v && (TRIN as readonly string[]).includes(v);
}

export default function MeldProblemFlow({
  tradeId,
  koeberId,
  valg: valgListe,
  kraeverBeskyttelse,
  erhverv,
  vare,
  frist,
  handelSti,
}: {
  tradeId: string;
  koeberId: string;
  valg: SagValgMulighed[];
  kraeverBeskyttelse: SagType[];
  erhverv: boolean;
  vare: SagVare;
  frist: SagFristVisning | null;
  handelSti: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const soeg = useSearchParams();
  const id = useId();
  const hydreret = useHydreret();

  const [valgId, setValgId] = useState<SagValgId | null>(null);
  const [billeder, setBilleder] = useState<ValgtBillede[]>([]);
  const [smidtUd, setSmidtUd] = useState(false);
  const [smidtUdGrund, setSmidtUdGrund] = useState("");
  const [tekst, setTekst] = useState("");
  // Fejlen vises først, når køberen har prøvet at gå videre.
  const [visFejl, setVisFejl] = useState(false);
  const [sendFejl, setSendFejl] = useState<string | null>(null);
  const [sender, setSender] = useState(false);
  const [fremskridt, setFremskridt] = useState<string | null>(null);
  const laas = useRef(false);
  useFrigivPreviews(billeder);

  const valgt = valgListe.find((v) => v.id === valgId) ?? null;
  // Billedkravene fra serveren. "Jeg har ikke pakken længere" (regel 2):
  // samme regel som sagBilledKrav - pakkebilledet udgår, indholdet kræves.
  const krav: SagBilledKrav[] = useMemo(() => {
    if (!valgt) return [];
    if (!smidtUd || !valgt.smidtUdMulig) return valgt.billeder;
    return sagBilledKrav(SAG_VALG[valgt.id], valgt.billeder.length > 0, true).filter(
      (k) => k.kategori !== "pakke_label",
    );
  }, [valgt, smidtUd]);
  const harBilledtrin = valgt ? valgt.billeder.length > 0 : valgListe.some((v) => v.billeder.length > 0);
  const trinListe: Trin[] = harBilledtrin ? ["hvad", "billeder", "beskriv", "tjek"] : ["hvad", "beskriv", "tjek"];

  // Hvad mangler i hvert trin?
  const manglerBilleder = krav.filter((k) => k.paakraevet && !billeder.some((b) => b.kategori === k.kategori));
  const tekstLaengde = tekst.trim().length;
  const tekstKontakt = indeholderKontaktinfo(tekst) || (smidtUd && indeholderKontaktinfo(smidtUdGrund));
  const grundLaengde = smidtUdGrund.trim().length;
  const tekstOk =
    tekstLaengde >= SAG_BESKRIVELSE_MIN &&
    tekstLaengde <= SAG_BESKRIVELSE_MAKS &&
    !tekstKontakt &&
    (!smidtUd || (grundLaengde >= SAG_SMIDT_UD_BEGRUNDELSE_MIN && grundLaengde <= SAG_SMIDT_UD_BEGRUNDELSE_MAKS));
  const klar: Record<Trin, boolean> = {
    hvad: !!valgt,
    billeder: !!valgt && manglerBilleder.length === 0,
    beskriv: tekstOk,
    tjek: true,
  };

  // Det trin, der vises: det i adressen - men aldrig et trin, hvis forrige
  // trin mangler noget (fx efter en genindlæsning).
  const oensket: Trin = erTrin(soeg?.get("trin") ?? null) ? (soeg!.get("trin") as Trin) : "hvad";
  let trin: Trin = "hvad";
  for (const t of trinListe) {
    trin = t;
    if (t === oensket || !klar[t]) break;
  }
  const nr = trinListe.indexOf(trin) + 1;
  const ialt = trinListe.length;

  // Fokus på trinnets overskrift ved skift (skærmlæsere hører det nye trin).
  const overskrift = useRef<HTMLHeadingElement>(null);
  const foerste = useRef(true);
  useEffect(() => {
    if (foerste.current) {
      foerste.current = false;
      return;
    }
    overskrift.current?.focus();
    window.scrollTo({ top: 0 });
  }, [trin]);

  function gaaTil(t: Trin) {
    setVisFejl(false);
    setSendFejl(null);
    const p = new URLSearchParams(soeg?.toString() ?? "");
    if (t === "hvad") p.delete("trin");
    else p.set("trin", t);
    const q = p.toString();
    window.history.pushState(null, "", `${pathname}${q ? `?${q}` : ""}`);
  }

  function naeste() {
    if (!klar[trin]) {
      setVisFejl(true);
      return;
    }
    const i = trinListe.indexOf(trin);
    if (i < trinListe.length - 1) gaaTil(trinListe[i + 1]);
  }

  function tilbage() {
    const i = trinListe.indexOf(trin);
    if (i <= 0) {
      router.push(handelSti);
      return;
    }
    gaaTil(trinListe[i - 1]);
  }

  function vaelg(v: SagValgMulighed) {
    setValgId(v.id);
    if (!v.smidtUdMulig) setSmidtUd(false);
    setVisFejl(false);
    gaaTil(v.billeder.length > 0 ? "billeder" : "beskriv");
  }

  function brugForslag(f: string, felt: "tekst" | "grund") {
    const saet = felt === "tekst" ? setTekst : setSmidtUdGrund;
    saet((t) => (t.trim() ? `${t.trim()} ${f}` : f));
  }

  // De billeder, der sendes: kun dem i de nuværende krav.
  const kategorier = new Set(krav.map((k) => k.kategori));
  const sendes = billeder.filter((b) => kategorier.has(b.kategori));

  async function send() {
    if (laas.current || !valgt) return;
    setSendFejl(null);
    laas.current = true;
    setSender(true);
    try {
      let klare = sendes;
      if (sendes.length > 0) {
        const res = await uploadBilleder(koeberId, tradeId, sendes, (n, i) =>
          setFremskridt(sagUdfyld(SAG_FLOW.trin4.uploader, { n, ialt: i })),
        );
        // Gem stierne, så billederne ikke uploades igen ved et nyt forsøg.
        const stier = new Map(res.billeder.map((b) => [b.id, b.sti]));
        setBilleder((alle) => alle.map((b) => (stier.get(b.id) ? { ...b, sti: stier.get(b.id) } : b)));
        if ("fejl" in res) {
          setSendFejl(res.fejl);
          return;
        }
        klare = res.billeder;
      }
      setFremskridt(SAG_FLOW.trin4.opretter);
      const res = await opretSag(
        tradeId,
        valgt.type,
        tekst,
        klare.map((b) => ({ sti: b.sti!, kategori: b.kategori })),
        smidtUd && valgt.smidtUdMulig ? { pakkeSmidtUd: true, begrundelse: smidtUdGrund } : null,
        valgt.id,
      );
      if ("fejl" in res) {
        setSendFejl(res.fejl);
        return;
      }
      router.replace(`${pathname}/sendt?valg=${valgt.id}`);
    } catch {
      setSendFejl(GENERISK);
    } finally {
      laas.current = false;
      setSender(false);
      setFremskridt(null);
    }
  }

  // ---------------------------------------------------------------- Knapper
  const kraevede = krav.filter((k) => k.paakraevet).length;
  const tagneKraevede = kraevede - manglerBilleder.length;
  let bundTekst: string | null = null;
  if (trin === "billeder") {
    bundTekst =
      manglerBilleder.length === 0
        ? SAG_FLOW.trin2.alleTaget
        : sagUdfyld(SAG_FLOW.trin2.status, { taget: tagneKraevede, ialt: kraevede });
  } else if (trin === "beskriv") {
    bundTekst = tekstOk ? SAG_TEKST.godt : SAG_TEKST.for_kort;
  }

  const bund =
    trin === "hvad" ? null : (
      <div className="flex flex-col gap-1.5 lg:flex-row-reverse lg:items-center lg:gap-4">
        {trin === "tjek" ? (
          <button
            type="button"
            onClick={send}
            disabled={sender || !hydreret}
            aria-busy={sender}
            className="btn btn-primaer btn-stor w-full lg:w-auto lg:min-w-60"
          >
            {sender ? <span className="btn-spinner" aria-hidden="true" /> : <SendIkon />}
            {SAG_FLOW.trin4.send}
          </button>
        ) : (
          <button
            type="button"
            onClick={naeste}
            aria-disabled={!klar[trin]}
            aria-describedby={bundTekst ? `${id}-bund` : undefined}
            className="btn btn-primaer btn-stor w-full lg:w-auto lg:min-w-60"
          >
            {SAG_FLOW.naeste}
          </button>
        )}
        {bundTekst && (
          <p id={`${id}-bund`} className="text-center text-xs text-tekst-svag lg:text-left" aria-live="polite">
            {bundTekst}
          </p>
        )}
        {trin === "tjek" && fremskridt && (
          <p role="status" aria-live="polite" className="text-center text-xs text-tekst-daempet lg:text-left">
            {fremskridt}
          </p>
        )}
      </div>
    );

  return (
    <div className={`mx-auto w-full max-w-5xl px-4 pt-4 sm:px-6 lg:px-8 lg:pb-12 ${bund ? "pb-40" : "pb-10"}`}>
      <button
        type="button"
        onClick={tilbage}
        className="-ml-1 inline-flex min-h-11 items-center gap-1 px-1 text-sm font-semibold text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        <Ikon navn="venstre" className="h-4 w-4" />
        {SAG_FLOW.tilbage}
      </button>
      <h1 className="mt-1 text-2xl leading-tight sm:text-[30px]">{SAG_FLOW.titel}</h1>

      {/* Statuslinjen */}
      <div className="mt-3 max-w-[640px]">
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${ialt}, minmax(0, 1fr))` }} aria-hidden="true">
          {trinListe.map((t, i) => (
            <span key={t} className={`h-1 ${i < nr ? "bg-groen" : "bg-kant"}`} />
          ))}
        </div>
        <p className="mt-1.5 text-[13px] text-tekst-svag">{sagUdfyld(SAG_FLOW.trin, { n: nr, ialt })}</p>
      </div>

      <div className="mt-4 lg:mt-5 lg:grid lg:grid-cols-[minmax(0,640px)_340px] lg:items-start lg:gap-10">
        <div className="border border-kant bg-white px-4 pb-6 pt-5 sm:px-6">
          {trin === "hvad" && (
            <TrinHvad
              ref={overskrift}
              valg={valgListe}
              valgtId={valgId}
              onVaelg={vaelg}
              kraeverBeskyttelse={kraeverBeskyttelse}
              erhverv={erhverv}
            />
          )}
          {trin === "billeder" && valgt && (
            <TrinBilleder
              ref={overskrift}
              valg={valgt}
              krav={krav}
              billeder={billeder}
              onChange={setBilleder}
              visFejl={visFejl}
              smidtUd={smidtUd}
              onSmidtUd={setSmidtUd}
              laast={sender}
            />
          )}
          {trin === "beskriv" && valgt && (
            <TrinBeskriv
              ref={overskrift}
              valg={valgt}
              tekst={tekst}
              onTekst={setTekst}
              smidtUd={smidtUd && valgt.smidtUdMulig}
              grund={smidtUdGrund}
              onGrund={setSmidtUdGrund}
              onForslag={brugForslag}
              visFejl={visFejl}
            />
          )}
          {trin === "tjek" && valgt && (
            <TrinTjek
              ref={overskrift}
              valg={valgt}
              vare={vare}
              billeder={sendes}
              harBilledtrin={valgt.billeder.length > 0}
              tekst={tekst}
              smidtUdGrund={smidtUd && valgt.smidtUdMulig ? smidtUdGrund : null}
              onRet={gaaTil}
              fejl={sendFejl}
              laast={sender}
            />
          )}

          {/* Computer: knapperne i bunden af kortet. */}
          {bund && <div className="mt-6 hidden lg:block">{bund}</div>}
        </div>

        <div className="mt-5 lg:mt-0 lg:sticky lg:top-24">
          <SagVareKort vare={vare} frist={frist} />
        </div>
      </div>

      {/* Mobil: fast knap nederst (samme mønster som checkout). */}
      {bund && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-kant bg-white px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-[0_-4px_16px_rgba(0,0,0,.06)] lg:hidden">
          {bund}
        </div>
      )}
    </div>
  );
}

function SendIkon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 14l11 -11" />
      <path d="M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5" />
    </svg>
  );
}

function Overskrift({
  ref,
  titel,
  hjaelp,
}: {
  ref: Ref<HTMLHeadingElement>;
  titel: string;
  hjaelp?: string;
}) {
  return (
    <div>
      <h2 ref={ref} tabIndex={-1} className="text-[22px] leading-tight focus:outline-none">
        {titel}
      </h2>
      {hjaelp && <p className="mt-1 text-[15px] text-tekst-daempet">{hjaelp}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ Trin 1
function TrinHvad({
  ref,
  valg,
  valgtId,
  onVaelg,
  kraeverBeskyttelse,
  erhverv,
}: {
  ref: Ref<HTMLHeadingElement>;
  valg: SagValgMulighed[];
  valgtId: SagValgId | null;
  onVaelg: (v: SagValgMulighed) => void;
  kraeverBeskyttelse: SagType[];
  erhverv: boolean;
}) {
  return (
    <>
      <Overskrift ref={ref} titel={SAG_FLOW.trin1.titel} hjaelp={SAG_FLOW.trin1.hjaelp} />
      <ul className="mt-5 grid gap-2.5">
        {valg.map((v) => {
          const er = v.id === valgtId;
          return (
            <li key={v.id}>
              <button
                type="button"
                onClick={() => onVaelg(v)}
                aria-pressed={er}
                className={`flex min-h-[72px] w-full items-center gap-3.5 border-[1.5px] p-3.5 text-left transition-colors hover:border-groen hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                  er ? "border-groen bg-groen-lys" : "border-kant-staerk bg-white"
                }`}
              >
                <span className="grid h-[46px] w-[46px] shrink-0 place-items-center bg-groen-lys text-groen-mork">
                  <ValgIkon valg={v.id} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-semibold leading-snug text-tekst">{v.navn}</span>
                  <span className="mt-0.5 block text-[13.5px] leading-snug text-tekst-daempet">{v.undertekst}</span>
                </span>
                <Ikon navn="hoejre" className="h-5 w-5 shrink-0 text-tekst-svag" />
              </button>
            </li>
          );
        })}
      </ul>
      {kraeverBeskyttelse.length > 0 && (
        <p className="mt-4 border border-info-kant bg-info-bg p-3 text-sm text-info-tekst">
          {erhverv
            ? SAG_FLOW.handel.kraeverBeskyttelseErhverv
            : sagUdfyld(SAG_FLOW.handel.kraeverBeskyttelse, {
                typer: kraeverBeskyttelse.map((t) => SAG_TYPE_NAVN[t].toLowerCase()).join(" eller "),
              })}{" "}
          <Link href="/bidhamr-beskyttelse" className="font-semibold underline">
            {SAG_FLOW.handel.laesMere}
          </Link>
        </p>
      )}
      <p className="mt-5 flex items-start gap-1.5 text-xs text-tekst-svag">
        <Ikon navn="skjold" className="h-4 w-4 shrink-0" />
        {SAG_FLOW.trin1.note}
      </p>
    </>
  );
}

// ------------------------------------------------------------------ Trin 2
function TrinBilleder({
  ref,
  valg,
  krav,
  billeder,
  onChange,
  visFejl,
  smidtUd,
  onSmidtUd,
  laast,
}: {
  ref: Ref<HTMLHeadingElement>;
  valg: SagValgMulighed;
  krav: SagBilledKrav[];
  billeder: ValgtBillede[];
  onChange: (b: ValgtBillede[]) => void;
  visFejl: boolean;
  smidtUd: boolean;
  onSmidtUd: (v: boolean) => void;
  laast: boolean;
}) {
  const [fejl, setFejl] = useState<string | null>(null);
  const antal = krav.filter((k) => k.paakraevet).length;
  const mangler = krav.some((k) => k.paakraevet && !billeder.some((b) => b.kategori === k.kategori));

  function tilfoej(kategori: SagBilledKrav["kategori"], filer: FileList | null) {
    setFejl(null);
    if (!filer || filer.length === 0) return;
    const nye: ValgtBillede[] = [];
    for (const fil of Array.from(filer)) {
      if (billeder.length + nye.length >= SAG_MAKS_BILLEDER) {
        setFejl(`Du kan højst tilføje ${SAG_MAKS_BILLEDER} billeder.`);
        break;
      }
      if (!filType(fil)) {
        setFejl(UPLOAD_FEJL.ugyldig_type);
        continue;
      }
      // Store billeder gøres mindre ved afsendelse; afvis kun de helt store.
      if (fil.size > SAG_MAKS_BILLEDSTOERRELSE * 3) {
        setFejl(UPLOAD_FEJL.for_stor);
        continue;
      }
      nye.push({ id: crypto.randomUUID(), fil, kategori, preview: URL.createObjectURL(fil) });
    }
    if (nye.length) onChange([...billeder, ...nye]);
  }

  function fjern(bid: string) {
    const b = billeder.find((x) => x.id === bid);
    if (b) URL.revokeObjectURL(b.preview);
    onChange(billeder.filter((x) => x.id !== bid));
  }

  return (
    <>
      <Overskrift
        ref={ref}
        titel={antal === 1 ? SAG_FLOW.trin2.titelEn : sagUdfyld(SAG_FLOW.trin2.titelFlere, { antal })}
        hjaelp={SAG_BILLEDER_INTRO}
      />
      <ol className="mt-5 grid gap-2.5">
        {krav.map((k, i) => (
          <BilledFelt
            key={k.kategori}
            nr={i + 1}
            krav={k}
            valgId={valg.id}
            egne={billeder.filter((b) => b.kategori === k.kategori)}
            visFejl={visFejl}
            laast={laast || billeder.length >= SAG_MAKS_BILLEDER}
            onTilfoej={(f) => tilfoej(k.kategori, f)}
            onFjern={fjern}
          />
        ))}
      </ol>

      {/* "Pakken er smidt ud" (regel 2) - ikke ved en tom pakke. */}
      {valg.smidtUdMulig && (
        <div className="mt-4">
          {smidtUd ? (
            <div className="border border-info-kant bg-info-bg p-3 text-sm text-info-tekst">
              <p>{SAG_FLOW.trin2.smidtUdValgt}</p>
              <button
                type="button"
                onClick={() => onSmidtUd(false)}
                className="mt-1 inline-flex min-h-11 items-center font-semibold underline"
              >
                {SAG_FLOW.trin2.smidtUdFortryd}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onSmidtUd(true)}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-groen underline underline-offset-2"
            >
              {SAG_SMIDT_UD.knap}
            </button>
          )}
        </div>
      )}

      <p className="mt-4 text-xs text-tekst-svag">{SAG_BILLEDER_HJAELP}</p>
      {fejl && (
        <p role="alert" className="mt-3 border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
      {visFejl && mangler && (
        <p role="alert" className="mt-3 border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {SAG_FLOW.trin2.manglerFejl}
        </p>
      )}
    </>
  );
}

function BilledFelt({
  nr,
  krav,
  valgId,
  egne,
  visFejl,
  laast,
  onTilfoej,
  onFjern,
}: {
  nr: number;
  krav: SagBilledKrav;
  valgId: SagValgId;
  egne: ValgtBillede[];
  visFejl: boolean;
  laast: boolean;
  onTilfoej: (f: FileList | null) => void;
  onFjern: (id: string) => void;
}) {
  const id = useId();
  const [ulaeselige, setUlaeselige] = useState<ReadonlySet<string>>(new Set());
  const taget = egne.length > 0;
  const mangler = krav.paakraevet && !taget;
  const ramme = taget
    ? "border-groen bg-groen-lys"
    : mangler && visFejl
      ? "border-fejl-kant bg-white"
      : "border-kant-staerk bg-white";

  return (
    <li className={`border p-3 ${ramme}`} aria-labelledby={`${id}-titel`}>
      <div className="flex gap-3">
        <div className="relative h-[76px] w-[76px] shrink-0 overflow-hidden border border-kant bg-white">
          {taget && !ulaeselige.has(egne[0].id) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={egne[0].preview}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setUlaeselige((s) => new Set(s).add(egne[0].id))}
            />
          ) : (
            <SagEksempel motiv={eksempelMotiv(krav.kategori, valgId)} />
          )}
          <span
            className={`absolute bottom-0 left-0 px-1.5 py-px text-[10.5px] font-bold text-white ${
              taget ? "bg-groen" : "bg-tekst/70"
            }`}
            aria-hidden="true"
          >
            {taget ? SAG_FLOW.trin2.ditBillede : SAG_FLOW.trin2.eksempel}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
            <h3 id={`${id}-titel`} className="text-[15px] font-semibold leading-snug text-tekst">
              {nr}. {krav.titel}
            </h3>
            <Status taget={taget} paakraevet={krav.paakraevet} fremhaev={visFejl} />
          </div>
          <p id={`${id}-hjaelp`} className="mt-0.5 text-[13px] leading-snug text-tekst-daempet">
            {krav.hjaelp}
          </p>
        </div>
      </div>

      {taget && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label={`Dine billeder: ${krav.titel}`}>
          {egne.map((b, i) => (
            <li key={b.id} className="relative h-16 w-16 overflow-hidden border border-kant bg-skelet">
              {ulaeselige.has(b.id) ? (
                <span className="flex h-full w-full items-center justify-center break-all p-1 text-center text-[10px] text-tekst-daempet">
                  {b.fil.name}
                </span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={b.preview}
                  alt={`Dit billede ${i + 1}: ${krav.titel.toLowerCase()}`}
                  className="h-full w-full object-cover"
                  onError={() => setUlaeselige((s) => new Set(s).add(b.id))}
                />
              )}
              <button
                type="button"
                onClick={() => onFjern(b.id)}
                aria-label={`${SAG_FLOW.trin2.fjern} ${i + 1}: ${krav.titel.toLowerCase()}`}
                className="absolute right-0.5 top-0.5 grid h-7 w-7 place-items-center rounded-full bg-white/95 text-tekst shadow"
              >
                <Ikon navn="luk" className="h-3.5 w-3.5" strøg={2.25} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        {/* Kameraet åbnes direkte på mobilen (capture). På computeren åbner
            begge knapper filvælgeren. */}
        <label
          htmlFor={`${id}-kamera`}
          className={`btn btn-lille cursor-pointer ${
            taget ? "btn-sekundaer" : "bg-groen text-white hover:bg-groen-mork"
          } ${laast ? "pointer-events-none opacity-50" : ""} focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-groen`}
        >
          <KameraIkon />
          {taget ? SAG_FLOW.trin2.tagFlere : SAG_FLOW.trin2.tagBillede}
        </label>
        <input
          id={`${id}-kamera`}
          type="file"
          accept="image/*"
          capture="environment"
          disabled={laast}
          aria-describedby={`${id}-titel ${id}-hjaelp`}
          className="sr-only"
          onChange={(e) => {
            onTilfoej(e.target.files);
            e.target.value = "";
          }}
        />
        <label
          htmlFor={`${id}-fil`}
          className={`inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-groen underline underline-offset-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-groen ${
            laast ? "pointer-events-none opacity-50" : ""
          }`}
        >
          {SAG_FLOW.trin2.vaelgFil}
        </label>
        <input
          id={`${id}-fil`}
          type="file"
          accept={ACCEPT}
          multiple
          disabled={laast}
          aria-describedby={`${id}-titel ${id}-hjaelp`}
          className="sr-only"
          onChange={(e) => {
            onTilfoej(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </li>
  );
}

function Status({ taget, paakraevet, fremhaev }: { taget: boolean; paakraevet: boolean; fremhaev: boolean }) {
  if (taget) {
    return (
      <span className="inline-flex items-center gap-1 bg-white px-2 py-0.5 text-xs font-semibold text-groen-mork">
        <Ikon navn="flueben" className="h-3.5 w-3.5" strøg={2.5} />
        {SAG_FLOW.trin2.taget}
      </span>
    );
  }
  if (!paakraevet) {
    return <span className="bg-kant px-2 py-0.5 text-xs font-semibold text-tekst-daempet">{SAG_FLOW.trin2.valgfrit}</span>;
  }
  return (
    <span
      className={`px-2 py-0.5 text-xs font-semibold ${
        fremhaev ? "bg-fejl-bg text-fejl-tekst" : "bg-advarsel-bg text-advarsel-tekst"
      }`}
    >
      {SAG_FLOW.trin2.mangler}
    </span>
  );
}

function KameraIkon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 7h1a2 2 0 0 0 2 -2a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2" />
      <path d="M9 13a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
    </svg>
  );
}

// ------------------------------------------------------------------ Trin 3
function TrinBeskriv({
  ref,
  valg,
  tekst,
  onTekst,
  smidtUd,
  grund,
  onGrund,
  onForslag,
  visFejl,
}: {
  ref: Ref<HTMLHeadingElement>;
  valg: SagValgMulighed;
  tekst: string;
  onTekst: (t: string) => void;
  smidtUd: boolean;
  grund: string;
  onGrund: (t: string) => void;
  onForslag: (f: string, felt: "tekst" | "grund") => void;
  visFejl: boolean;
}) {
  const id = useId();
  const laengde = tekst.trim().length;
  const tekstFejl = indeholderKontaktinfo(tekst)
    ? SAG_OPRET_FEJL.kontaktinfo
    : visFejl && (laengde < SAG_BESKRIVELSE_MIN || laengde > SAG_BESKRIVELSE_MAKS)
      ? SAG_OPRET_FEJL.ugyldig_beskrivelse
      : null;
  const gl = grund.trim().length;
  const grundFejl = !smidtUd
    ? null
    : indeholderKontaktinfo(grund)
      ? SAG_OPRET_FEJL.kontaktinfo
      : visFejl && (gl < SAG_SMIDT_UD_BEGRUNDELSE_MIN || gl > SAG_SMIDT_UD_BEGRUNDELSE_MAKS)
        ? SAG_OPRET_FEJL.smidt_ud_begrundelse
        : null;
  const felt = (fejl: boolean) =>
    `min-h-[130px] w-full resize-y border bg-white px-3.5 py-3 text-base leading-relaxed text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25 ${
      fejl ? "border-fejl-kant" : "border-kant-staerk"
    }`;

  return (
    <>
      <Overskrift ref={ref} titel={SAG_TEKST.titel} hjaelp={SAG_TEKST.hjaelp} />
      <div className="mt-5">
        <label htmlFor={`${id}-tekst`} className="sr-only">
          {SAG_FLOW.trin3.label}
        </label>
        <textarea
          id={`${id}-tekst`}
          value={tekst}
          onChange={(e) => onTekst(e.target.value)}
          maxLength={SAG_BESKRIVELSE_MAKS}
          rows={5}
          placeholder={SAG_FLOW.trin3.pladsholder}
          aria-invalid={!!tekstFejl}
          aria-describedby={tekstFejl ? `${id}-tekst-fejl` : undefined}
          className={felt(!!tekstFejl)}
        />
        {tekstFejl && (
          <p id={`${id}-tekst-fejl`} role="alert" className="mt-1.5 text-sm text-fejl-tekst">
            {tekstFejl}
          </p>
        )}
        <Forslag tekster={valg.tekstforslag} onVaelg={(f) => onForslag(f, "tekst")} />
      </div>

      {smidtUd && (
        <div className="mt-6">
          <label htmlFor={`${id}-grund`} className="block text-[17px] font-semibold text-tekst">
            {SAG_SMIDT_UD.titel}
          </label>
          <p id={`${id}-grund-hjaelp`} className="mt-1 text-sm text-tekst-daempet">
            {SAG_SMIDT_UD.hjaelp}
          </p>
          <textarea
            id={`${id}-grund`}
            value={grund}
            onChange={(e) => onGrund(e.target.value)}
            maxLength={SAG_SMIDT_UD_BEGRUNDELSE_MAKS}
            rows={3}
            placeholder={SAG_FLOW.trin3.smidtUdPladsholder}
            aria-invalid={!!grundFejl}
            aria-describedby={`${id}-grund-hjaelp${grundFejl ? ` ${id}-grund-fejl` : ""}`}
            className={`mt-2 ${felt(!!grundFejl)}`}
          />
          {grundFejl ? (
            <p id={`${id}-grund-fejl`} role="alert" className="mt-1.5 text-sm text-fejl-tekst">
              {grundFejl}
            </p>
          ) : (
            gl < SAG_SMIDT_UD_BEGRUNDELSE_MIN && (
              <p className="mt-1.5 text-xs text-tekst-svag">
                {sagUdfyld(SAG_FLOW.trin3.smidtUdForKort, { min: SAG_SMIDT_UD_BEGRUNDELSE_MIN })}
              </p>
            )
          )}
          <Forslag tekster={[...SAG_SMIDT_UD.forslag]} onVaelg={(f) => onForslag(f, "grund")} />
        </div>
      )}

      <HvisDuFaarRet tekst={valg.hvisDuFaarRet} />
    </>
  );
}

function Forslag({ tekster, onVaelg }: { tekster: string[]; onVaelg: (t: string) => void }) {
  if (tekster.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="mb-2 text-xs text-tekst-svag">{SAG_TEKST.forslagIntro}</p>
      <ul className="flex flex-wrap gap-2">
        {tekster.map((t) => (
          <li key={t}>
            <button
              type="button"
              onClick={() => onVaelg(t)}
              className="min-h-[38px] border border-groen-lys bg-groen-lys px-3 py-1.5 text-left text-sm font-medium leading-snug text-groen-mork hover:border-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              {t}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HvisDuFaarRet({ tekst }: { tekst: string }) {
  return (
    <div className="mt-6 bg-groen-lys p-4">
      <h3 className="text-[15px] font-semibold text-groen-mork">{SAG_FLOW.hvisDuFaarRet}</h3>
      <p className="mt-1 text-sm text-tekst">{tekst}</p>
    </div>
  );
}

// ------------------------------------------------------------------ Trin 4
function RetKnap({
  til,
  hvad,
  onRet,
  laast,
}: {
  til: Trin;
  hvad: string;
  onRet: (t: Trin) => void;
  laast: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onRet(til)}
      disabled={laast}
      className="inline-flex min-h-11 shrink-0 items-center px-1 text-sm font-semibold text-groen hover:underline disabled:opacity-50"
    >
      {SAG_FLOW.trin4.ret}
      <span className="sr-only">: {hvad.toLowerCase()}</span>
    </button>
  );
}

function TrinTjek({
  ref,
  valg,
  vare,
  billeder,
  harBilledtrin,
  tekst,
  smidtUdGrund,
  onRet,
  fejl,
  laast,
}: {
  ref: Ref<HTMLHeadingElement>;
  valg: SagValgMulighed;
  vare: SagVare;
  billeder: ValgtBillede[];
  harBilledtrin: boolean;
  tekst: string;
  smidtUdGrund: string | null;
  onRet: (t: Trin) => void;
  fejl: string | null;
  laast: boolean;
}) {
  return (
    <>
      <Overskrift ref={ref} titel={SAG_FLOW.trin4.titel} />
      <dl className="mt-3 border-t border-kant">
        <div className="border-b border-kant py-3.5">
          <dt className="mb-1.5 text-xs text-tekst-svag">{SAG_FLOW.trin4.varen}</dt>
          <dd>
            <VareLinje vare={vare} lille />
          </dd>
        </div>
        <div className="flex items-start gap-3 border-b border-kant py-3.5">
          <div className="min-w-0 flex-1">
            <dt className="text-xs text-tekst-svag">{SAG_FLOW.trin4.problem}</dt>
            <dd className="text-[15px] text-tekst">{valg.navn}</dd>
          </div>
          <RetKnap til="hvad" hvad={SAG_FLOW.trin4.problem} onRet={onRet} laast={laast} />
        </div>
        {harBilledtrin && (
          <div className="flex items-start gap-3 border-b border-kant py-3.5">
            <div className="min-w-0 flex-1">
              <dt className="text-xs text-tekst-svag">{SAG_FLOW.trin4.billeder}</dt>
              <dd className="mt-1">
                {billeder.length === 0 ? (
                  <span className="text-sm text-tekst-svag">{SAG_FLOW.trin4.ingenBilleder}</span>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {billeder.map((b, i) => (
                      <li key={b.id} className="h-16 w-16 overflow-hidden border border-kant bg-skelet">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={b.preview} alt={`Billede ${i + 1}`} className="h-full w-full object-cover" />
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            <RetKnap til="billeder" hvad={SAG_FLOW.trin4.billeder} onRet={onRet} laast={laast} />
          </div>
        )}
        <div className="flex items-start gap-3 border-b border-kant py-3.5">
          <div className="min-w-0 flex-1">
            <dt className="text-xs text-tekst-svag">{SAG_FLOW.trin4.tekst}</dt>
            <dd className="whitespace-pre-wrap break-words text-[15px] text-tekst">{tekst.trim()}</dd>
          </div>
          <RetKnap til="beskriv" hvad={SAG_FLOW.trin4.tekst} onRet={onRet} laast={laast} />
        </div>
        {smidtUdGrund !== null && (
          <div className="flex items-start gap-3 border-b border-kant py-3.5">
            <div className="min-w-0 flex-1">
              <dt className="text-xs text-tekst-svag">{SAG_FLOW.trin4.smidtUd}</dt>
              <dd className="whitespace-pre-wrap break-words text-[15px] text-tekst">{smidtUdGrund.trim()}</dd>
            </div>
            <RetKnap til="beskriv" hvad={SAG_FLOW.trin4.smidtUd} onRet={onRet} laast={laast} />
          </div>
        )}
      </dl>

      <h3 className="mt-6 text-[17px] font-semibold text-tekst">{SAG_FLOW.trin4.detSker}</h3>
      <ol className="mt-3 grid gap-3">
        {SAG_DET_SKER.map((t, i) => (
          <li key={t} className="flex gap-3 text-[15px] leading-snug">
            <span
              className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-groen text-[13px] font-bold text-white"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <span className="pt-0.5">{t}</span>
          </li>
        ))}
      </ol>

      <HvisDuFaarRet tekst={valg.hvisDuFaarRet} />

      {fejl && (
        <p role="alert" className="mt-5 border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
    </>
  );
}
