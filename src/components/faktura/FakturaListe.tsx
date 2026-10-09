// Liste over brugerens fakturaer og kreditnotaer fra BidHamr (server-
// komponent, ingen klient-JS). Data fra mine_fakturaer (kun egne).
// Bruges på /konto/fakturaer, handelssiden og firma-dashboardets Regninger.
import Link from "next/link";
import { kroner } from "@/lib/kroner";
import { FAKTURA_TEKST as T } from "@/lib/faktura/tekster";
import type { MinFaktura } from "@/lib/faktura/data";

function dato(iso: string) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Copenhagen",
  });
}

export default function FakturaListe({
  fakturaer,
  visHandel = true,
  handelSti = (id: string) => `/mine-handler/${id}`,
}: {
  fakturaer: MinFaktura[];
  visHandel?: boolean;
  handelSti?: (tradeId: string) => string;
}) {
  return (
    <ul className="divide-y divide-kant rounded-[14px] border border-kant bg-white">
      {fakturaer.map((f) => {
        const kredit = f.dokument === "kreditnota";
        return (
          <li key={f.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
            <div className="min-w-0">
              <p className="text-[16px] font-semibold text-tekst">
                {kredit ? T.kreditnota(f.nummer, f.krediterer_nummer) : T.faktura(f.nummer)}
              </p>
              <p className="mt-0.5 text-sm break-words text-tekst-daempet">
                {f.part === "saelger" ? T.salg(f.titel) : T.koeb(f.titel)} · {dato(f.dato)}
              </p>
              <dl className="mt-2 space-y-0.5 text-sm text-tekst-daempet">
                {f.linjer.map((l, i) => (
                  <div key={i} className="flex justify-between gap-6 sm:justify-start">
                    <dt>{l.tekst}</dt>
                    <dd className="tabular-nums whitespace-nowrap">
                      {kredit ? "− " : ""}
                      {kroner(l.beloeb_oere)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-[15px] font-semibold text-tekst tabular-nums">
                I alt {kredit ? "− " : ""}
                {kroner(f.beloeb_oere)}{" "}
                <span className="text-sm font-normal text-tekst-daempet">({T.hermoms(`${kredit ? "− " : ""}${kroner(f.moms_oere)}`)})</span>
              </p>
              {kredit && <p className="mt-1 text-sm text-tekst-daempet">{T.kreditForklaring}</p>}
              {visHandel && f.trade_id && (
                <Link
                  href={handelSti(f.trade_id)}
                  className="mt-1 inline-flex min-h-11 items-center rounded-md text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                >
                  {T.seHandlen}
                </Link>
              )}
            </div>
            <div className="shrink-0">
              {f.klar ? (
                <a href={`/api/faktura/${f.id}`} target="_blank" rel="noopener" className="btn btn-sekundaer w-full sm:w-auto">
                  {kredit ? T.hentKreditnotaPdf : T.hentPdf}
                </a>
              ) : (
                <p className="max-w-[28ch] text-sm text-tekst-daempet">{T.paaVej}</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
