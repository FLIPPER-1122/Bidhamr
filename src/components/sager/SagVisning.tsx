// Sagen på handelssiden - for både køber og sælger. Server-komponent.
// Opbygning (så enkelt som muligt for kunden):
//   1. Tidslinje: hvor er sagen nu?
//   2. "Det skal du gøre nu": én kort sætning og højst én knap.
//   3. Seneste besked fra BidHamr om sagen (med link til at svare).
//   4. Detaljer foldet sammen.
// Ingen kronebeløb. BidHamr holder aldrig pengene: betalingen håndteres af
// vores betalingspartner Stripe.
import Link from "next/link";
import type { MinSag } from "@/app/actions/sager";
import type { StaffBesked } from "@/app/actions/staffChat";
import { SAG_MAKS_BILLEDER, SAG_TYPE_NAVN } from "@/lib/sager";
import TilfoejSagBilleder from "./TilfoejSagBilleder";
import { BeskyttelseBadge, SagBilleder, SagStatusBadge, sagTid } from "./visning";

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

function tidslinje(sag: MinSag): { trin: Trin[]; aktiv: number; alleFaerdige: boolean } {
  const medRetur = sag.returKraeves || sag.status === "afventer_retur";
  const lukketUdenPenge = sag.status === "lukket" || sag.pengeHandling === "ingen";
  const afgjort = sag.status !== "aaben";

  const trin: Trin[] = [
    { noegle: "oprettet", navn: "Sag oprettet", note: kortDato(sag.oprettetKl) },
    { noegle: "behandler", navn: "BidHamr behandler" },
    {
      noegle: "afgjort",
      navn: "Afgjort",
      note: afgjort && sag.afgjortKl ? kortDato(sag.afgjortKl) : undefined,
    },
  ];
  if (medRetur) {
    trin.push({
      noegle: "retur",
      navn: "Send varen retur",
      note: sag.returAfleveretKl ? `Afleveret ${kortDato(sag.returAfleveretKl)}` : undefined,
    });
  }
  trin.push({
    noegle: "slut",
    navn: lukketUdenPenge ? "Sagen er lukket" : sag.afvikletKl ? "Pengene er sendt" : "Pengene er på vej",
    note:
      afgjort && sag.status !== "afventer_retur" && !sag.afvikletKl && sag.pengeFlyttesEfterKl
        ? `Tidligst ${kortDato(sag.pengeFlyttesEfterKl)}`
        : undefined,
  });

  const idx = (n: string) => trin.findIndex((t) => t.noegle === n);
  let aktiv: number;
  if (sag.status === "aaben") aktiv = idx("behandler");
  else if (sag.status === "afventer_retur") aktiv = idx("retur");
  else aktiv = idx("slut");
  const alleFaerdige = !!sag.afvikletKl || (sag.status === "lukket" && !sag.pengeFlyttesEfterKl);
  return { trin, aktiv, alleFaerdige };
}

function Tidslinje({ sag }: { sag: MinSag }) {
  const { trin, aktiv, alleFaerdige } = tidslinje(sag);
  return (
    <ol className="flex flex-col gap-0 sm:flex-row sm:gap-2" aria-label="Sagens forløb">
      {trin.map((t, i) => {
        const faerdig = alleFaerdige || i < aktiv;
        const nu = !alleFaerdige && i === aktiv;
        const sidste = i === trin.length - 1;
        return (
          <li
            key={t.noegle}
            aria-current={nu ? "step" : undefined}
            className="relative flex gap-3 pb-4 last:pb-0 sm:flex-1 sm:flex-col sm:items-center sm:gap-2 sm:pb-0 sm:text-center"
          >
            {/* Forbindelseslinje: lodret på mobil, vandret fra sm. */}
            {!sidste && (
              <span
                aria-hidden="true"
                className={`absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-0.5 sm:left-[calc(50%+18px)] sm:top-[13px] sm:h-0.5 sm:w-[calc(100%-36px+0.5rem)] ${
                  faerdig ? "bg-groen" : "bg-kant"
                }`}
              />
            )}
            <span
              aria-hidden="true"
              className={`relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                faerdig
                  ? "bg-groen text-white"
                  : nu
                    ? "bg-orange-knap text-white ring-4 ring-orange-lys"
                    : "border-2 border-kant-staerk bg-white text-tekst-svag"
              }`}
            >
              {faerdig ? (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                i + 1
              )}
            </span>
            <span className="min-w-0 pt-0.5 sm:pt-0">
              <span
                className={`block text-sm ${
                  nu ? "font-semibold text-tekst" : faerdig ? "font-medium text-tekst" : "text-tekst-svag"
                }`}
              >
                {t.navn}
                {nu && <span className="sr-only"> (nu)</span>}
              </span>
              {t.note && <span className="block text-xs text-tekst-daempet">{t.note}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// "Det skal du gøre nu": én kort sætning pr. rolle og status.
function goerNu(sag: MinSag): { tekst: string; handling: boolean } {
  const k = sag.erKoeber;
  const dato = sag.pengeFlyttesEfterKl ? datoITekst(sag.pengeFlyttesEfterKl) : "";
  const venter = !sag.afvikletKl && !!dato;
  const tidligst = dato ? ` – tidligst ${dato}` : "";
  // Med BidHamr Beskyttelse er Beskyttelsen "brugt" og refunderes ikke.
  // Returfragten betaler køberen selv direkte til fragtfirmaet.
  const hvad = sag.beskyttelse ? "pengene for varen, gebyret og fragten" : "alle pengene";
  const beskyttelseNote = sag.beskyttelse ? " BidHamr Beskyttelse refunderes ikke." : "";

  switch (sag.status) {
    case "aaben":
      return k
        ? { tekst: "Du skal ikke gøre noget nu. BidHamr kigger på sagen og vender tilbage hurtigst muligt.", handling: false }
        : { tekst: "Du skal ikke gøre noget nu. Udbetalingen venter, mens BidHamr kigger på sagen.", handling: false };
    case "afventer_retur":
      return k
        ? {
            tekst: `Send varen retur til sælgeren. Du betaler selv returfragten. Når pakken er afleveret, får du ${hvad} tilbage${tidligst}.${beskyttelseNote}`,
            handling: true,
          }
        : {
            tekst: "Køberen sender varen retur til dig og betaler selv returfragten. Du skal ikke gøre noget nu.",
            handling: false,
          };
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
          <span className="rounded-full bg-orange-knap px-2 py-0.5 text-[11px] font-semibold text-white">Ny</span>
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

export default function SagVisning({
  sag,
  brugerId,
  samtale,
}: {
  sag: MinSag;
  brugerId: string;
  samtale: SagSamtale | null;
}) {
  const nu = goerNu(sag);
  const kanTilfoejeBilleder = sag.erKoeber && sag.status === "aaben" && sag.billeder.length < SAG_MAKS_BILLEDER;

  return (
    <section
      id="sag"
      aria-labelledby="sag-titel"
      className="scroll-mt-24 rounded-[14px] border border-kant bg-white p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="sag-titel" className="font-serif text-xl font-semibold text-tekst">
          {sag.erKoeber ? "Din sag" : "Sag fra køberen"}
        </h2>
        <SagStatusBadge status={sag.status} />
      </div>

      <div className="mt-5">
        <Tidslinje sag={sag} />
      </div>

      <div
        className={`mt-5 rounded-xl p-4 sm:p-5 ${
          nu.handling ? "border border-orange bg-orange-lys" : "bg-groen-lys"
        }`}
      >
        <h3 className="text-sm font-semibold text-groen-mork">
          {tidslinje(sag).alleFaerdige ? "Sådan endte sagen" : "Det skal du gøre nu"}
        </h3>
        <p className="mt-1 text-[15px] text-tekst">{nu.tekst}</p>

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

      <details className="group mt-4 rounded-xl border border-kant">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-semibold text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen [&::-webkit-details-marker]:hidden">
          Se detaljer om sagen
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

        <div className="space-y-5 border-t border-kant px-4 py-4">
          {sag.begrundelse && sag.status !== "aaben" && (
            <div>
              <h4 className="text-sm font-semibold text-tekst">BidHamrs begrundelse</h4>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-tekst">{sag.begrundelse}</p>
            </div>
          )}

          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-tekst-svag">Hvad sagen drejer sig om</dt>
              <dd className="font-medium text-tekst">{SAG_TYPE_NAVN[sag.type]}</dd>
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

          <div>
            <h4 className="text-sm font-semibold text-tekst">Køberens beskrivelse</h4>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-tekst">{sag.beskrivelse}</p>
          </div>

          <div>
            <h4 className="mb-2 text-sm font-semibold text-tekst">Billeder ({sag.billeder.length})</h4>
            <SagBilleder billeder={sag.billeder} />
          </div>
        </div>
      </details>
    </section>
  );
}
