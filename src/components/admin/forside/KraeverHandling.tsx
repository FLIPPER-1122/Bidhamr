import Link from "next/link";
import type { HandlingTal } from "./forsideTal";
import { HAENGER_GRAENSER_DAGE } from "@/lib/adminGraenser";

type Kort = {
  titel: string;
  antal: number;
  href: string;
  // Kort forklaring under titlen (fx grænsen for "hænger").
  detalje?: string;
};

function HandlingKort({ titel, antal, href, detalje }: Kort) {
  const klaret = antal === 0;
  return (
    <Link
      href={href}
      className={`flex min-w-0 items-start justify-between gap-3 rounded-xl border p-4 transition-colors ${
        klaret
          ? "border-succes-kant bg-succes-bg/60 text-succes-tekst hover:bg-succes-bg"
          : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst hover:border-advarsel-tekst"
      }`}
    >
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${klaret ? "" : "text-neutral-900"}`}>{titel}</p>
        {detalje && (
          <p className={`mt-0.5 text-xs ${klaret ? "opacity-80" : ""}`}>{detalje}</p>
        )}
      </div>
      <span
        className={`shrink-0 text-2xl font-bold tabular-nums leading-none ${klaret ? "opacity-70" : ""}`}
        aria-label={klaret ? "Ingen" : `${antal} venter`}
      >
        {antal}
      </span>
    </Link>
  );
}

function betalingDetalje(h: HandlingTal) {
  const dele: string[] = [];
  if (h.overfoersel_fejlet > 0) {
    dele.push(`${h.overfoersel_fejlet} ${h.overfoersel_fejlet === 1 ? "fejlet overførsel" : "fejlede overførsler"}`);
  }
  if (h.refusion_fejlet > 0) {
    dele.push(`${h.refusion_fejlet} ${h.refusion_fejlet === 1 ? "fejlet refusion" : "fejlede refusioner"}`);
  }
  if (h.afvigelser > 0) {
    dele.push(`${h.afvigelser} med afvigende beløb`);
  }
  return dele.length ? `Heraf ${dele.join(", ")}` : "Fejlede overførsler, refusioner og afvigende beløb";
}

export default function KraeverHandling({
  tal,
  visKontolukninger,
}: {
  tal: HandlingTal;
  // Forslag om kontolukning behandles af admin/chef (/admin/kontolukninger).
  visKontolukninger: boolean;
}) {
  const kort: Kort[] = [
    { titel: "Åbne sager", antal: tal.aabne_sager, href: "/admin/sager", detalje: "Venter på en afgørelse" },
    {
      titel: "Returfrist udløbet",
      antal: tal.retur_udloebet,
      href: "/admin/sager?vis=afventer_retur",
      detalje: "Køberens 7 dage til at sende varen retur er gået",
    },
    { titel: "Anker", antal: tal.anker, href: "/admin/sager?vis=anker", detalje: "Venter på en admin eller chef" },
    { titel: "Nye rapporter", antal: tal.rapporter, href: "/admin/rapporter", detalje: "Ikke set på endnu" },
    {
      titel: "Betalt, ikke sendt",
      antal: tal.ikke_sendt,
      href: "/admin/handler?vis=haenger",
      detalje: `Mere end ${HAENGER_GRAENSER_DAGE.ikke_sendt} dage siden betalingen`,
    },
    {
      titel: "Sendt, ikke modtaget",
      antal: tal.ikke_modtaget,
      href: "/admin/handler?vis=haenger",
      detalje: `Mere end ${HAENGER_GRAENSER_DAGE.ikke_modtaget} dage siden afsendelsen`,
    },
    {
      titel: "Afhentning ikke gennemført",
      antal: tal.afhentning,
      href: "/admin/handler?vis=haenger",
      detalje: `Mere end ${HAENGER_GRAENSER_DAGE.afhentning} dage siden betalingen`,
    },
    {
      titel: "Ubetalte vindere",
      antal: tal.ubetalte,
      href: "/admin/ubetalte",
      detalje: "Venter på en medarbejder",
    },
    {
      titel: "Betalinger kræver handling",
      antal: tal.betalinger + tal.afvigelser,
      href: "/admin/betalinger",
      detalje: betalingDetalje(tal),
    },
    {
      titel: "Udbetalingskonti",
      antal: tal.udbetalingskonti,
      href: "/admin/betalinger",
      detalje: "Sælgerens konto hos Stripe kræver opmærksomhed",
    },
  ];
  if (visKontolukninger) {
    kort.push({
      titel: "Forslag om kontolukning",
      antal: tal.kontolukninger,
      href: "/admin/kontolukninger",
      detalje: "Venter på godkendelse",
    });
  }

  const ialt = kort.reduce((sum, k) => sum + k.antal, 0);

  return (
    <section aria-labelledby="kraever-handling" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="kraever-handling" className="text-lg font-bold text-neutral-900">
          Kræver handling nu
        </h2>
        <p className={`text-sm ${ialt === 0 ? "text-succes-tekst" : "text-neutral-500"}`}>
          {ialt === 0 ? "Alt er klaret lige nu." : `${ialt} ting venter i alt`}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {kort.map((k) => (
          <HandlingKort key={k.titel} {...k} />
        ))}
      </div>
    </section>
  );
}
