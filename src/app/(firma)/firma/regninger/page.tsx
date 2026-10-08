import { kraevFirma } from "@/lib/erhverv/firmaData";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { FIRMA_OVERSIGT as T, FIRMA_OVERSIGT_EKSTRA as X } from "@/lib/tekster/erhverv";
import { krFraOere, langDato } from "@/lib/erhverv/visning";

// Regninger fra BidHamr (firma_regninger via firma_oversigt). Tom, indtil
// Stripe/regnskabsprogrammet laver regningerne.

export const metadata = { title: T.regninger.titel };

export default async function FirmaRegninger() {
  const { oversigt: o } = await kraevFirma("/firma/regninger");

  return (
    <FirmaSide titel={T.regninger.titel} intro={T.regninger.forklaring}>
      <Kort id="regninger">
        {o.regninger.length === 0 ? (
          <p className={E_TEKST}>{T.regninger.tom}</p>
        ) : (
          <ul className="divide-y divide-kant rounded-[14px] border border-kant">
            {o.regninger.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[19px] font-semibold text-tekst">
                    {X.regningType[r.type]} · {krFraOere(r.beloeb_oere)}
                  </p>
                  <p className={E_TEKST_DAEMPET}>
                    {T.regninger.kolonneDato}: {langDato(r.oprettet)} · {X.regningStatus[r.status]}
                  </p>
                </div>
                {r.pdf_url && (
                  <a href={r.pdf_url} target="_blank" rel="noopener noreferrer" className={E_KNAP_SEKUNDAER}>
                    {T.regninger.knapHent}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Kort>
    </FirmaSide>
  );
}
