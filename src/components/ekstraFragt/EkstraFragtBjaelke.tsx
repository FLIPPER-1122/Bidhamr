// Tydelig bjælke, når sælgeren har en ubetalt regning for ekstra fragt (Min
// konto, Mine handler, firma-oversigten, Opret auktion). Rød med BHX01-
// teksten, når fristen er overskredet (sælgeren er spærret for nye
// auktioner), ellers orange. Knappen går direkte til betalingen på handlen
// (?ekstrafragt=betal åbner Stripes betaling med det samme).
// Server-komponent uden egen datahentning: kalderen giver regningerne
// (hentMineEkstraFragtRegninger) - null/tom = ingen bjælke.
import Link from "next/link";
import type { MinEkstraFragt } from "@/app/actions/ekstraFragt";
import { ekstraFragtSpaerretTekst } from "@/lib/ekstraFragt/tekster";
import { ekstraFragtDato, ekstraFragtHref, erReturfragtRegning } from "@/lib/ekstraFragt/visning";
import { kroner } from "@/lib/kroner";

export default function EkstraFragtBjaelke({
  regninger,
  firma = false,
  className = "",
}: {
  regninger: MinEkstraFragt[] | null;
  firma?: boolean;
  className?: string;
}) {
  const ubetalte = (regninger ?? []).filter((r) => r.status === "afventer_betaling");
  if (ubetalte.length === 0) return null;
  const spaerrende = ubetalte.filter((r) => r.spaerrer);
  const spaerret = spaerrende.length > 0;
  // Den, der haster mest: en spærrende, ellers den med den tidligste frist.
  const foerste = [...(spaerret ? spaerrende : ubetalte)].sort((a, b) => Date.parse(a.frist) - Date.parse(b.frist))[0];
  const ialt = ubetalte.reduce((s, r) => s + Number(r.beloeb_oere), 0);
  const flere = ubetalte.length > 1;
  // Regninger for returfragt i en sag hedder "returfragt" (20261102350000).
  const slags = (rr: MinEkstraFragt[]) => ({
    returfragt: rr.some((x) => erReturfragtRegning(x)),
    ekstra: rr.some((x) => !erReturfragtRegning(x)),
  });
  const alle = slags(ubetalte);
  const hvad = alle.returfragt && alle.ekstra ? "ekstra fragt og returfragt" : alle.returfragt ? "returfragt" : "ekstra fragt";

  return (
    <div
      role={spaerret ? "alert" : "status"}
      className={`rounded-none border p-4 sm:p-5 ${
        spaerret ? "border-fejl-kant bg-fejl-bg text-fejl-tekst" : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"
      } ${className}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
        <div className="min-w-0">
          <p className="text-[16px] font-semibold">
            {flere
              ? `Du har ${ubetalte.length} ubetalte regninger for ${hvad} på i alt ${kroner(ialt)}.`
              : `Du har en ubetalt regning for ${hvad}: ${kroner(ialt)}.`}
          </p>
          <p className="mt-1 text-sm">
            {spaerret
              ? ekstraFragtSpaerretTekst(slags(spaerrende))
              : alle.returfragt && !alle.ekstra
                ? `Køberen har sendt varen retur til dig, og som sælger betaler du returfragten. Betal senest ${ekstraFragtDato(foerste.frist)}.`
                : `Fragtfirmaet har målt ${flere ? "pakker" : "en pakke"}, du har sendt, som større eller tungere end den størrelse, du valgte. Betal senest ${ekstraFragtDato(foerste.frist)}.`}
          </p>
        </div>
        <Link
          href={ekstraFragtHref(foerste.trade_id, { firma, betal: true })}
          className="btn btn-primaer w-full shrink-0 sm:w-auto"
        >
          Betal {kroner(Number(foerste.beloeb_oere))}.
        </Link>
      </div>
    </div>
  );
}
