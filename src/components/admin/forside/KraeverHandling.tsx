import Link from "next/link";
import type { HandlingTal } from "./forsideTal";
import { HAENGER_GRAENSER_DAGE } from "@/lib/adminGraenser";

type Kort = {
  titel: string;
  antal: number;
  href: string;
  // Hverdagsforklaring: hvad er der sket, og hvad skal du gøre?
  forklaring: string;
  // Valgfri ekstra detalje (fx grænsen for "hænger").
  detalje?: string;
};

function HandlingKort({ titel, antal, href, forklaring, detalje }: Kort) {
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-xl border border-advarsel-kant bg-advarsel-bg p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-sm font-semibold text-neutral-900">{titel}</h3>
        <span
          className="shrink-0 text-2xl font-bold tabular-nums leading-none text-advarsel-tekst"
          aria-label={`${antal} venter`}
        >
          {antal}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-neutral-800">{forklaring}</p>
        {detalje && <p className="mt-1 text-xs text-advarsel-tekst">{detalje}</p>}
      </div>
      <Link
        href={href}
        className="inline-flex min-h-10 items-center justify-center self-start rounded-lg bg-orange-knap px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-knap-mork"
      >
        Gå til<span className="sr-only"> {titel.toLowerCase()}</span>
      </Link>
    </li>
  );
}

function betalingDetalje(h: HandlingTal) {
  const dele: string[] = [];
  if (h.overfoersel_fejlet > 0) {
    dele.push(`${h.overfoersel_fejlet} ${h.overfoersel_fejlet === 1 ? "fejlet udbetaling" : "fejlede udbetalinger"}`);
  }
  if (h.refusion_fejlet > 0) {
    dele.push(`${h.refusion_fejlet} ${h.refusion_fejlet === 1 ? "fejlet refusion" : "fejlede refusioner"}`);
  }
  if (h.afvigelser > 0) {
    dele.push(`${h.afvigelser} med forkert beløb`);
  }
  return dele.length ? `Heraf ${dele.join(", ")}` : undefined;
}

export default function KraeverHandling({
  tal,
  visKontolukninger,
}: {
  tal: HandlingTal;
  // Forslag om kontolukning behandles af admin/chef (/admin/kontolukninger).
  visKontolukninger: boolean;
}) {
  // Rækkefølgen er prioriteten: det vigtigste står først.
  const alle: Kort[] = [
    {
      titel: "Åbne sager",
      antal: tal.aabne_sager,
      href: "/admin/sager",
      forklaring: "Køber har klaget over en handel – afgør sagen.",
    },
    {
      titel: "Anker",
      antal: tal.anker,
      href: "/admin/sager?vis=anker",
      forklaring: "En bruger er uenig i en afgørelse – en admin eller chef skal se på den igen.",
    },
    {
      titel: "Betalinger, der er gået galt",
      antal: tal.betalinger + tal.afvigelser,
      href: "/admin/betalinger",
      forklaring: "En udbetaling eller refusion fejlede, eller beløbet passer ikke – ret det.",
      detalje: betalingDetalje(tal),
    },
    {
      titel: "Returfrist udløbet",
      antal: tal.retur_udloebet,
      href: "/admin/sager?vis=afventer_retur",
      forklaring: "Køberen har ikke sendt varen retur inden for 7 dage – afslut sagen.",
    },
    {
      titel: "Ubetalte vindere",
      antal: tal.ubetalte,
      href: "/admin/ubetalte",
      forklaring: "En vinder betalte ikke til tiden – giv en advarsel, eller afvis.",
    },
    {
      titel: "Nye rapporter",
      antal: tal.rapporter,
      href: "/admin/rapporter",
      forklaring: "Brugere har anmeldt en auktion – tjek opslaget.",
    },
    {
      titel: "Betalt, men ikke sendt",
      antal: tal.ikke_sendt,
      href: "/admin/handler?vis=haenger",
      forklaring: "Sælger har ikke sendt varen – kontakt sælgeren.",
      detalje: `Mere end ${HAENGER_GRAENSER_DAGE.ikke_sendt} dage siden betalingen`,
    },
    {
      titel: "Sendt, men ikke modtaget",
      antal: tal.ikke_modtaget,
      href: "/admin/handler?vis=haenger",
      forklaring: "Pakken er ikke kommet frem – tjek forsendelsen.",
      detalje: `Mere end ${HAENGER_GRAENSER_DAGE.ikke_modtaget} dage siden afsendelsen`,
    },
    {
      titel: "Fragt kræver handling",
      antal: tal.fragt,
      href: "/admin/handler?vis=fragt",
      forklaring: "Fragtfirmaet har meldt noget, der skal tjekkes – fx en pakke, sælgeren ikke har markeret sendt.",
    },
    {
      titel: "Afhentning ikke gennemført",
      antal: tal.afhentning,
      href: "/admin/handler?vis=haenger",
      forklaring: "Køber og sælger har ikke mødtes – hør hvordan det går.",
      detalje: "Fristen for afhentning er overskredet",
    },
    {
      titel: "Sælgers udbetalingskonto",
      antal: tal.udbetalingskonti,
      href: "/admin/betalinger",
      forklaring: "En sælger kan ikke få penge udbetalt – hjælp med kontoen.",
    },
  ];
  if (visKontolukninger) {
    alle.push({
      titel: "Forslag om kontolukning",
      antal: tal.kontolukninger,
      href: "/admin/kontolukninger",
      forklaring: "En bruger har fået 3 advarsler – godkend eller afvis lukningen.",
    });
  }

  const kort = alle.filter((k) => k.antal > 0);

  return (
    <section aria-labelledby="kraever-handling" className="space-y-3">
      <h2 id="kraever-handling" className="text-lg font-bold text-neutral-900">
        Kræver handling nu
      </h2>
      {kort.length === 0 ? (
        <p
          role="status"
          className="rounded-xl border border-succes-kant bg-succes-bg p-5 text-sm font-medium text-succes-tekst"
        >
          Der er intet, der venter på dig lige nu.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {kort.map((k) => (
            <HandlingKort key={k.titel} {...k} />
          ))}
        </ul>
      )}
    </section>
  );
}
