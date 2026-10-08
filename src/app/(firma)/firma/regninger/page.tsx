import { kraevFirma } from "@/lib/erhverv/firmaData";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { FIRMA_BETALING as B, FIRMA_OVERSIGT as T, FIRMA_OVERSIGT_EKSTRA as X } from "@/lib/tekster/erhverv";
import { krFraOere, langDato } from "@/lib/erhverv/visning";

// Regninger fra BidHamr (firma_regninger via firma_oversigt). Fakturaerne
// laves af Stripe Billing (src/lib/erhverv/betaling.ts): beløb ekskl. moms,
// moms (25 %) og i alt, "Hent faktura (PDF)" og - for en ubetalt regning -
// Stripes fakturaside. Kun https-links.

export const metadata = { title: T.regninger.titel };

function https(url: string | null): url is string {
  return typeof url === "string" && url.startsWith("https://");
}

export default async function FirmaRegninger() {
  const { oversigt: o } = await kraevFirma("/firma/regninger");

  return (
    <FirmaSide titel={T.regninger.titel} intro={T.regninger.forklaring}>
      <Kort id="regninger">
        {o.regninger.length === 0 ? (
          <p className={E_TEKST}>{T.regninger.tom}</p>
        ) : (
          <ul className="divide-y divide-kant rounded-[14px] border border-kant">
            {o.regninger.map((r) => {
              const ubetalt = r.status === "afventer" || r.status === "mislykket";
              return (
                <li key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-[19px] font-semibold text-tekst">
                      {X.regningType[r.type]} · {krFraOere(r.beloeb_oere)}
                    </p>
                    {r.beloeb_ekskl_moms_oere != null && r.moms_oere != null && (
                      <p className={E_TEKST_DAEMPET}>
                        {B.regningBeloeb(krFraOere(r.beloeb_ekskl_moms_oere), krFraOere(r.moms_oere), krFraOere(r.beloeb_oere))}
                      </p>
                    )}
                    <p className={E_TEKST_DAEMPET}>
                      {r.nummer ? `${B.regningNummer(r.nummer)} · ` : ""}
                      {T.regninger.kolonneDato}: {langDato(r.oprettet)} ·{" "}
                      <span className={ubetalt ? "font-semibold text-fejl-tekst" : ""}>{X.regningStatus[r.status]}</span>
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:items-end">
                    {ubetalt && https(r.hosted_url) && (
                      <a href={r.hosted_url} className={E_KNAP_PRIMAER} rel="noopener noreferrer">
                        {B.knapSeRegning}
                      </a>
                    )}
                    {https(r.pdf_url) && (
                      <a href={r.pdf_url} target="_blank" rel="noopener noreferrer" className={E_KNAP_SEKUNDAER}>
                        {B.knapHentPdf}
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Kort>
    </FirmaSide>
  );
}
