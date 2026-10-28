// Sagen på handelssiden (#sag) - for både køber og sælger. Server-komponent.
// Opbygning som showcase/opret-sag-showcase.html skærm 9-12:
//   1. Status og problemet øverst.
//   2. "Det skal du gøre nu": én kort sætning og højst én knap (sælgerens
//      forklaring, anke, flere billeder) + seneste besked fra BidHamr.
//   3. Afgørelsen, returfragten og anken.
//   4. Tidslinjen "Sådan går det videre".
//   5. Det, køberen har sendt, sælgerens forklaring og pakkebillederne.
//   6. Detaljer foldet sammen.
// Teksterne står i src/lib/tekster/sagValg.ts (SAG_FLOW.sag), så appen
// kan bruge de samme.
// Ingen kronebeløb. BidHamr holder aldrig pengene: betalingen håndteres af
// vores betalingspartner Stripe.
import Link from "next/link";
import type { MinSag } from "@/app/actions/sager";
import type { StaffBesked } from "@/app/actions/staffChat";
import { SAG_MAKS_BILLEDER, SAG_TYPE_NAVN } from "@/lib/sager";
import TilfoejSagBilleder from "./TilfoejSagBilleder";
import SagSvarForm from "./SagSvarForm";
import { SAG_FLOW, sagUdfyld } from "@/lib/tekster/sagValg";
import AnkeForm from "./AnkeForm";
import { BeskyttelseBadge, SagBilleder, SagStatusBadge, sagTid } from "./visning";
import { SAG_REFUSION_NY } from "@/lib/tekster/beskyttelse";

export type SagSamtale = { id: string; lukket: boolean; seneste: StaffBesked | null; ulaest: boolean };

type Trin = { noegle: string; navn: string; note?: string };

// Kort dato til tidslinjen og teksterne, fx "6. okt." (fast tidszone).
function kortDato(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Copenhagen",
  });
}

// Dato i en sætning, fx "7. oktober" (ingen forkortelsespunktum før punktum).
function datoITekst(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Copenhagen",
  });
}

// Dato og klokkeslæt i en sætning, fx "7. oktober kl. 14.05" (ankefristen
// gælder til minuttet).
function datoOgTid(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString("da-DK", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

function tidslinje(sag: MinSag): { trin: Trin[]; aktiv: number; alleFaerdige: boolean } {
  const medRetur = sag.returKraeves || sag.status === "afventer_retur";
  const lukketUdenPenge = sag.status === "lukket" || sag.pengeHandling === "ingen";
  const afgjort = sag.status !== "aaben";
  const anke = sag.anke;
  const ankeVenter = anke?.status === "afventer";

  const tl = SAG_FLOW.sag.tidslinje;
  const trin: Trin[] = [
    {
      noegle: "oprettet",
      navn: sag.erKoeber ? tl.oprettetKoeber : tl.oprettetSaelger,
      note: sagTid(sag.oprettetKl),
    },
    {
      noegle: "behandler",
      navn: tl.behandler,
      note: afgjort ? undefined : sag.erKoeber ? tl.behandlerNoteKoeber : tl.behandlerNoteSaelger,
    },
    {
      noegle: "afgjort",
      navn: tl.afgjort,
      // Er afgørelsen ændret på anke, er afgjortKl tidspunktet for ankens
      // afgørelse - den dato står på anke-trinnet.
      note:
        afgjort && sag.afgjortKl && anke?.status !== "omgjort"
          ? kortDato(sag.afgjortKl)
          : afgjort
            ? undefined
            : tl.afgjortNote,
    },
  ];
  if (anke) {
    trin.push({
      noegle: "anke",
      navn: tl.anke,
      note: ankeVenter ? "Behandles" : anke.behandletKl ? `Afgjort ${kortDato(anke.behandletKl)}` : undefined,
    });
  }
  // Medhold til køber med retur (uden anke): køberen venter med at sende
  // varen, til ankefristen er udløbet - sælgeren kan anke indtil da.
  if (medRetur && afgjort && !anke) {
    trin.push({
      noegle: "ankefrist",
      navn: tl.ankefrist,
      note: sag.returVenterTilKl ? `Til ${kortDato(sag.returVenterTilKl)}` : undefined,
    });
  }
  if (medRetur) {
    trin.push({
      noegle: "retur",
      navn: tl.retur,
      note: sag.returAfleveretKl ? `Afleveret ${kortDato(sag.returAfleveretKl)}` : undefined,
    });
  }
  trin.push({
    noegle: "slut",
    navn: lukketUdenPenge ? tl.slutLukket : sag.afvikletKl ? tl.slutSendt : tl.slutPenge,
    note:
      afgjort && !ankeVenter && sag.status !== "afventer_retur" && !sag.afvikletKl && sag.pengeFlyttesEfterKl
        ? `Tidligst ${kortDato(sag.pengeFlyttesEfterKl)}`
        : undefined,
  });

  const idx = (n: string) => trin.findIndex((t) => t.noegle === n);
  let aktiv: number;
  if (sag.status === "aaben") aktiv = idx("behandler");
  else if (ankeVenter) aktiv = idx("anke");
  else if (sag.status === "afventer_retur" && sag.returVenterTilKl) aktiv = idx("ankefrist");
  else if (sag.status === "afventer_retur") aktiv = idx("retur");
  else aktiv = idx("slut");
  const alleFaerdige = !!sag.afvikletKl || (sag.status === "lukket" && !sag.pengeFlyttesEfterKl);
  return { trin, aktiv, alleFaerdige };
}

function Tidslinje({ sag }: { sag: MinSag }) {
  const { trin, aktiv, alleFaerdige } = tidslinje(sag);
  return (
    <ol className="grid" aria-label="Sagens forløb">
      {trin.map((t, i) => {
        const faerdig = alleFaerdige || i < aktiv;
        const nu = !alleFaerdige && i === aktiv;
        const sidste = i === trin.length - 1;
        return (
          <li
            key={t.noegle}
            aria-current={nu ? "step" : undefined}
            className="relative grid grid-cols-[26px_1fr] gap-3 pb-4 last:pb-0"
          >
            {!sidste && (
              <span
                aria-hidden="true"
                className={`absolute left-3 top-6 bottom-0 w-0.5 ${faerdig ? "bg-groen" : "bg-kant"}`}
              />
            )}
            <span
              aria-hidden="true"
              className={`relative z-10 grid h-[26px] w-[26px] place-items-center rounded-full border-2 ${
                faerdig
                  ? "border-groen bg-groen text-white"
                  : nu
                    ? "border-orange-knap bg-white"
                    : "border-kant-staerk bg-white"
              }`}
            >
              {faerdig ? (
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                nu && <span className="h-2.5 w-2.5 rounded-full bg-orange-knap" />
              )}
            </span>
            <span className="min-w-0 pt-0.5">
              <span
                className={`block text-[15px] leading-snug ${
                  nu || faerdig ? "font-semibold text-tekst" : "font-medium text-tekst-daempet"
                }`}
              >
                {t.navn}
                {nu && <span className="sr-only"> (nu)</span>}
                {faerdig && <span className="sr-only"> (færdig)</span>}
              </span>
              {t.note && <span className="block text-[13px] leading-snug text-tekst-svag">{t.note}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// "Det skal du gøre nu" med anke: mens anken behandles, sker der intet med
// pengene; ellers sagens egen tekst + evt. "Du kan anke ...".
function goerNu(sag: MinSag): { tekst: string; handling: boolean; anke: "kan" | "snart" | null; ankeTekst: string | null } {
  const a = sag.anke;
  if (a && a.status === "afventer") {
    const pause = "En anden medarbejder ser på sagen igen. Pengene flyttes ikke, mens anken behandles.";
    const retur =
      sag.erKoeber && sag.status === "afventer_retur" ? " Vent med at sende varen retur, til anken er afgjort." : "";
    return {
      tekst: a.egen
        ? `Vi har modtaget din anke. ${pause} Du skal ikke gøre mere nu.`
        : `${a.part === "koeber" ? "Køberen" : "Sælgeren"} har anket afgørelsen. ${pause}${retur}`,
      handling: false,
      anke: null,
      ankeTekst: null,
    };
  }

  const basis = goerNuSag(sag);
  const m = sag.ankeMulighed;
  if (a) {
    return {
      ...basis,
      tekst: `Anken er afgjort, og afgørelsen er endelig. ${basis.tekst}`,
      anke: null,
      ankeTekst: null,
    };
  }
  if (m.kode === "kan_anke" && m.tilKl) {
    return { ...basis, anke: "kan", ankeTekst: `Er du uenig? Du kan anke afgørelsen indtil ${datoOgTid(m.tilKl)}.` };
  }
  if (m.kode === "for_tidligt" && m.fraKl) {
    return { ...basis, anke: "snart", ankeTekst: `Er du uenig? Du kan anke afgørelsen fra ${datoOgTid(m.fraKl)}.` };
  }
  return { ...basis, anke: null, ankeTekst: null };
}

// "Det skal du gøre nu": én kort sætning pr. rolle og status.
function goerNuSag(sag: MinSag): { tekst: string; handling: boolean } {
  const k = sag.erKoeber;
  const dato = sag.pengeFlyttesEfterKl ? datoITekst(sag.pengeFlyttesEfterKl) : "";
  const venter = !sag.afvikletKl && !!dato;
  const tidligst = dato ? ` – tidligst ${dato}` : "";
  // Samme regel som public.sag_refusion_oere (beregn.ts sagRefusionOere):
  // ny prismodel = kun buddet; gammel handel med tilkøbt BidHamr Beskyttelse =
  // alt undtagen Beskyttelsen. Returfragten betaler køberen selv direkte til
  // fragtfirmaet.
  // 20261102210000: bortkommet pakke og transportskade = hele beløbet.
  const hele = sag.type === "bortkommet" || sag.type === "skadet";
  const hvad = hele
    ? "hele beløbet – bud, gebyr og fragt"
    : sag.nyPrismodel
      ? "prisen for varen (dit bud)"
      : sag.beskyttelse
        ? "pengene for varen, gebyret og fragten"
        : "alle pengene";
  const beskyttelseNote = hele
    ? ""
    : sag.nyPrismodel
      ? " Gebyr og fragt får du ikke tilbage."
      : sag.beskyttelse
        ? " Prisen for BidHamr Beskyttelse får du ikke tilbage."
        : "";
  // Hvem betaler returfragten (sager.returfragt_betaler).
  const rfKoeber = sag.returfragtBetaler === "saelger" || sag.returfragtBetaler === "bidhamr"
    ? "Du betaler ikke returfragten."
    : "Du betaler selv returfragten.";
  const rfSaelger =
    sag.returfragtBetaler === "saelger"
      ? "Du betaler returfragten, fordi varen ikke var pakket forsvarligt. Du får en regning, når returpakken er afleveret."
      : sag.returfragtBetaler === "bidhamr"
        ? "BidHamr betaler returfragten."
        : "Køberen betaler selv returfragten.";

  switch (sag.status) {
    case "aaben":
      return k
        ? {
            tekst: `Du skal ikke gøre noget nu. BidHamr ser på sagen. Sælgeren får ikke pengene, mens sagen kører.${
              sag.nyPrismodel && !hele ? ` ${SAG_REFUSION_NY}` : ""
            }`,
            handling: false,
          }
        : sag.kanSvare && sag.svarFristKl
          ? {
              tekst: `BidHamr ser på sagen. Du kan give din forklaring med tekst og billeder indtil ${datoOgTid(sag.svarFristKl)}. Du får ikke pengene, før sagen er afgjort.`,
              handling: true,
            }
          : { tekst: "Du skal ikke gøre noget nu. Du får ikke pengene, før sagen er afgjort.", handling: false };
    case "afventer_retur":
      // Inden for ankefristen venter køberen med at sende varen: sælgeren kan
      // anke, og en omgørelse ville ellers give sælgeren både varen og pengene.
      if (sag.returVenterTilKl) {
        const frist = datoOgTid(sag.returVenterTilKl);
        return k
          ? {
              tekst: `Du har fået medhold. Sælgeren kan anke afgørelsen indtil ${frist}. Vent med at sende varen, til ankefristen er udløbet ${frist}, eller til BidHamr giver dig besked. Derefter sender du varen retur til sælgeren. ${rfKoeber} Når pakken er afleveret, får du ${hvad} tilbage.${beskyttelseNote}`,
              handling: false,
            }
          : {
              tekst: `Køberen har fået medhold og sender varen retur til dig, når ankefristen er udløbet ${frist}. ${rfSaelger}`,
              handling: false,
            };
      }
      {
        // Ventetid ved retur: har køberen ikke sendt varen inden fristen (7
        // dage efter beskeden), kan BidHamr afgøre sagen til sælgerens fordel.
        const returFrist = sag.returFristKl ? datoOgTid(sag.returFristKl) : null;
        return k
          ? {
              tekst: `Send varen retur til sælgeren nu. ${rfKoeber} Når pakken er afleveret, får du ${hvad} tilbage.${beskyttelseNote}${
                returFrist
                  ? ` Send varen senest ${returFrist} – ellers kan BidHamr afgøre sagen til sælgerens fordel.`
                  : ""
              }`,
              handling: true,
            }
          : {
              tekst: `Køberen sender varen retur til dig. ${rfSaelger}${
                returFrist ? ` Køberen har frist til ${returFrist}.` : ""
              } Du skal ikke gøre noget nu.`,
              handling: false,
            };
      }
    case "afgjort_koeber":
      if (k) {
        if (sag.afvikletKl) {
          return { tekst: "Pengene er sendt tilbage til dig. Der kan gå nogle dage, før de står på din konto.", handling: false };
        }
        return { tekst: `Du har fået medhold og får ${hvad} tilbage${tidligst}. Du skal ikke gøre mere.${beskyttelseNote}`, handling: false };
      }
      return venter
        ? { tekst: `Køberen har fået medhold og får pengene tilbage tidligst ${dato}. Handlen annulleres.`, handling: false }
        : { tekst: "Køberen har fået medhold og har fået pengene tilbage. Handlen er annulleret.", handling: false };
    case "afgjort_saelger":
      if (k) {
        return venter
          ? { tekst: `Sælgeren har fået medhold. Pengene udbetales til sælgeren tidligst ${dato}.`, handling: false }
          : { tekst: "Sælgeren har fået medhold, og pengene er udbetalt til sælgeren.", handling: false };
      }
      return venter
        ? { tekst: `Du har fået medhold. Pengene udbetales til dig tidligst ${dato}.`, handling: false }
        : { tekst: "Du har fået medhold, og pengene er udbetalt til dig.", handling: false };
    case "lukket":
      // Køberen kan anke en lukning (se goerNu - "Er du uenig? ...").
      return venter
        ? { tekst: `Sagen er lukket. Handlen fortsætter som normalt efter ${dato}.`, handling: false }
        : { tekst: "Sagen er lukket, og handlen fortsætter som normalt.", handling: false };
  }
}

function SenesteBesked({ samtale }: { samtale: SagSamtale }) {
  const b = samtale.seneste;
  return (
    <div className="mt-4 rounded-xl bg-white p-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-tekst">Besked fra BidHamr</span>
        {samtale.ulaest && (
          <span className="rounded-none bg-orange-knap px-2 py-0.5 text-[11px] font-semibold text-white">Ny</span>
        )}
      </div>
      {b ? (
        <>
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-sm text-tekst">{b.tekst}</p>
          <p className="mt-1 text-xs text-tekst-svag">{sagTid(b.oprettet_kl)}</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-tekst-daempet">BidHamr har startet en samtale med dig om sagen.</p>
      )}
      <Link
        href={`/beskeder/bidhamr/${samtale.id}`}
        className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        {samtale.lukket ? "Se samtalen" : "Svar BidHamr"}
        <span aria-hidden="true">&nbsp;→</span>
      </Link>
    </div>
  );
}

// Hvem betaler returfragten - "dækket" for køberen, når sælgeren eller
// BidHamr betaler (sager.returfragt_betaler; ReturlabelBoks åbner så ingen
// betaling).
function returfragtTekst(sag: MinSag): string | null {
  if (!sag.returKraeves && sag.status !== "afventer_retur") return null;
  const t = SAG_FLOW.sag;
  const b = sag.returfragtBetaler;
  if (sag.erKoeber) return b === "saelger" || b === "bidhamr" ? t.returfragtDaekket : t.returfragtSelv;
  if (b === "saelger") return t.returfragtDaekketSaelger;
  if (b === "bidhamr") return t.returfragtBidhamr;
  return t.returfragtKoeber;
}

// Venter køberen stadig på sælgerens forklaring (inden for 48 timer)?
function svarVenter(sag: MinSag): boolean {
  return (
    sag.erKoeber &&
    !sag.svar &&
    sag.status === "aaben" &&
    !!sag.svarFristKl &&
    Date.parse(sag.svarFristKl) > Date.now()
  );
}

export default function SagVisning({
  sag,
  brugerId,
  samtale,
}: {
  sag: MinSag;
  brugerId: string;
  samtale: SagSamtale | null;
}) {
  const t = SAG_FLOW.sag;
  const nu = goerNu(sag);
  const { alleFaerdige } = tidslinje(sag);
  const kanTilfoejeBilleder = sag.erKoeber && sag.status === "aaben" && sag.billeder.length < SAG_MAKS_BILLEDER;
  const problem = SAG_TYPE_NAVN[sag.type];
  const rf = returfragtTekst(sag);
  // Sælgerens forklaring (regel 3): sælgeren svarer direkte her.
  const visSvarForm = !sag.erKoeber && sag.kanSvare && !!sag.svarFristKl;
  const venterPaaSvar = svarVenter(sag);

  return (
    <section
      id="sag"
      aria-labelledby="sag-titel"
      className="scroll-mt-24 rounded-none border border-kant bg-white"
    >
      {/* Status øverst */}
      <div className="bg-groen-lys p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="sag-titel" className="text-xl leading-tight text-tekst">
            {sag.erKoeber ? t.titelKoeber : t.titelSaelger}
          </h2>
          <SagStatusBadge status={sag.status} />
        </div>
        <p className="mt-2 text-[17px] font-semibold leading-snug text-groen-mork">
          {sag.erKoeber ? problem : sagUdfyld(t.meldtSaelger, { problem: problem.toLowerCase() })}
        </p>
        <p className="mt-0.5 text-sm text-tekst-daempet">{sagUdfyld(t.meldt, { dato: sagTid(sag.oprettetKl) })}</p>
      </div>

      <div className="space-y-6 p-4 sm:p-5">
        {/* Det skal du gøre nu */}
        <div
          className={`p-4 sm:p-5 ${
            nu.handling ? "border border-advarsel-kant bg-advarsel-bg" : "border border-kant bg-[#FAFAFA]"
          }`}
        >
          <h3 className="text-[15px] font-semibold text-tekst">{alleFaerdige ? t.endte : t.goerNu}</h3>
          <p className="mt-1 text-[15px] text-tekst">{nu.tekst}</p>

          {nu.ankeTekst && <p className="mt-2 text-[15px] text-tekst">{nu.ankeTekst}</p>}
          {nu.anke === "kan" && sag.ankeMulighed.tilKl && (
            <div className="mt-3">
              <AnkeForm
                sagId={sag.id}
                tradeId={sag.tradeId}
                brugerId={brugerId}
                fristTekst={datoOgTid(sag.ankeMulighed.tilKl)}
              />
            </div>
          )}

          {visSvarForm && (
            <div className="mt-3">
              <SagSvarForm
                sagId={sag.id}
                tradeId={sag.tradeId}
                saelgerId={brugerId}
                fristTekst={sagTid(sag.svarFristKl!)}
              />
            </div>
          )}

          {kanTilfoejeBilleder && (
            <div className="mt-3">
              <TilfoejSagBilleder
                sagId={sag.id}
                tradeId={sag.tradeId}
                koeberId={brugerId}
                pladsTilbage={SAG_MAKS_BILLEDER - sag.billeder.length}
              />
            </div>
          )}

          {samtale && <SenesteBesked samtale={samtale} />}
        </div>

        {/* Afgørelsen */}
        {sag.begrundelse && sag.status !== "aaben" && (
          <div>
            <h3 className="text-[17px] font-semibold text-tekst">{t.afgoerelse}</h3>
            {sag.afgjortKl && <p className="text-xs text-tekst-svag">{sagTid(sag.afgjortKl)}</p>}
            <p className="mt-1.5 whitespace-pre-wrap break-words border-l-[3px] border-groen bg-groen-lys px-3 py-2.5 text-sm text-tekst">
              {sag.begrundelse}
            </p>
          </div>
        )}

        {rf && (
          <p className="text-sm text-tekst">
            <span className="font-semibold">{t.returfragt}:</span> {rf}
          </p>
        )}

        {/* Anken */}
        {sag.anke && (
          <div className="border border-info-kant bg-info-bg p-4">
            <h3 className="text-[15px] font-semibold text-tekst">
              {sag.anke.egen ? "Din anke" : `Anke fra ${sag.anke.part === "koeber" ? "køberen" : "sælgeren"}`}
            </h3>
            <p className="mt-0.5 text-xs text-tekst-daempet">
              Indgivet {sagTid(sag.anke.indgivetKl)} ·{" "}
              {sag.anke.status === "afventer"
                ? "behandles"
                : sag.anke.status === "stadfaestet"
                  ? "afgørelsen står"
                  : "afgørelsen er ændret"}
            </p>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-tekst">{sag.anke.begrundelse}</p>
            {sag.anke.billeder.length > 0 && (
              <div className="mt-3">
                <SagBilleder billeder={sag.anke.billeder} />
              </div>
            )}
            {sag.anke.afgoerelseBegrundelse && (
              <div className="mt-3">
                <h4 className="text-sm font-semibold text-tekst">BidHamrs afgørelse på anken</h4>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-tekst">
                  {sag.anke.afgoerelseBegrundelse}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Tidslinjen */}
        <div>
          <h3 className="mb-3 text-[17px] font-semibold text-tekst">{alleFaerdige ? t.endte : t.videre}</h3>
          <Tidslinje sag={sag} />
        </div>

        {/* Det har køberen sendt */}
        <div>
          <h3 className="text-[17px] font-semibold text-tekst">{sag.erKoeber ? t.duHarSendt : t.koeberSkriver}</h3>
          <p className="mt-1.5 whitespace-pre-wrap break-words border-l-[3px] border-kant-staerk bg-[#F7F7F7] px-3 py-2.5 text-sm text-tekst">
            {sag.beskrivelse}
          </p>
          {sag.pakkeSmidtUd && <p className="mt-2 text-xs text-tekst-svag">{t.smidtUd}</p>}
          {sag.billeder.length > 0 && (
            <>
              <p className="mb-2 mt-3 text-xs text-tekst-svag">{sag.erKoeber ? t.dineBilleder : t.koeberBilleder}</p>
              <SagBilleder billeder={sag.billeder} />
            </>
          )}
        </div>

        {/* Sælgerens forklaring (regel 3) - ses af køber og sælger. */}
        {sag.svar ? (
          <div>
            <h3 className="text-[17px] font-semibold text-tekst">{sag.erKoeber ? t.svarKoeber : t.svarSaelger}</h3>
            <p className="text-xs text-tekst-svag">{sagTid(sag.svar.oprettetKl)}</p>
            <p className="mt-1.5 whitespace-pre-wrap break-words border-l-[3px] border-kant-staerk bg-[#F7F7F7] px-3 py-2.5 text-sm text-tekst">
              {sag.svar.tekst}
            </p>
            {sag.svar.billeder.length > 0 && (
              <div className="mt-3">
                <SagBilleder billeder={sag.svar.billeder} />
              </div>
            )}
          </div>
        ) : (
          venterPaaSvar && (
            <div>
              <h3 className="text-[17px] font-semibold text-tekst">{t.svarKoeber}</h3>
              <p className="mt-1 text-sm text-tekst-daempet">
                {sagUdfyld(t.svarVenter, { dato: sagTid(sag.svarFristKl!) })}
              </p>
            </div>
          )
        )}

        {sag.pakkebilleder.length > 0 && (
          <div>
            <h3 className="text-[15px] font-semibold text-tekst">
              {sag.erKoeber ? t.pakkebillederKoeber : t.pakkebillederSaelger} ({sag.pakkebilleder.length})
            </h3>
            <p className="mb-2 mt-0.5 text-sm text-tekst-daempet">{t.pakkebillederHjaelp}</p>
            <SagBilleder billeder={sag.pakkebilleder} />
          </div>
        )}

        <details className="group border border-kant">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen [&::-webkit-details-marker]:hidden">
            {t.detaljer}
            <svg
              aria-hidden="true"
              className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <div className="space-y-4 border-t border-kant px-4 py-4">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-tekst-svag">Hvad sagen drejer sig om</dt>
                <dd className="font-medium text-tekst">{problem}</dd>
              </div>
              <div>
                <dt className="text-tekst-svag">Oprettet</dt>
                <dd className="font-medium text-tekst">{sagTid(sag.oprettetKl)}</dd>
              </div>
              {sag.afgjortKl && sag.status !== "aaben" && (
                <div>
                  <dt className="text-tekst-svag">Afgjort</dt>
                  <dd className="font-medium text-tekst">{sagTid(sag.afgjortKl)}</dd>
                </div>
              )}
              {sag.returAfleveretKl && (
                <div>
                  <dt className="text-tekst-svag">Returpakke afleveret</dt>
                  <dd className="font-medium text-tekst">{sagTid(sag.returAfleveretKl)}</dd>
                </div>
              )}
              {sag.genaabnetKl && (
                <div>
                  <dt className="text-tekst-svag">Genåbnet</dt>
                  <dd className="font-medium text-tekst">{sagTid(sag.genaabnetKl)}</dd>
                </div>
              )}
            </dl>
            {sag.beskyttelse && <BeskyttelseBadge />}
          </div>
        </details>
      </div>
    </section>
  );
}
