import { hentFirmaSalg, kraevFirma } from "@/lib/erhverv/firmaData";
import { FirmaSide, Kort, StatusMaerke, Tal } from "@/components/firma/dele";
import { E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { FIRMA_DASHBOARD as D } from "@/lib/tekster/erhverv";
import { krFraOere, langDato } from "@/lib/erhverv/visning";
import type { FirmaSalg } from "@/lib/erhverv/regler";

// Udbetalinger: penge på vej og udbetalt (betalinger-tabellen - samme
// regler som firma_oversigt) og pr. handel (firma_salg). Stripe holder alle
// penge; BidHamr har ingen saldo.

export const metadata = { title: D.udbetalinger.titel };

const U = D.udbetalinger;

function status(s: FirmaSalg[number]): { tekst: string; farve: string } {
  if (s.refunderet_kl) return { tekst: U.status.refunderet, farve: "border-fejl-kant bg-fejl-bg text-fejl-tekst" };
  if (s.overfoert_kl) return { tekst: U.status.udbetalt, farve: "border-succes-kant bg-succes-bg text-succes-tekst" };
  if (s.betaling_status === "betalt") return { tekst: U.status.paaVej, farve: "border-info-kant bg-info-bg text-info-tekst" };
  if (s.betaling_status === "annulleret" || s.status === "annulleret")
    return { tekst: U.status.annulleret, farve: "border-kant bg-white text-tekst-daempet" };
  return { tekst: U.status.venterBetaling, farve: "border-kant bg-white text-tekst-daempet" };
}

export default async function FirmaUdbetalinger() {
  const { oversigt: o } = await kraevFirma("/firma/udbetalinger");
  const salg = (await hentFirmaSalg()).filter((s) => s.udbetaling_oere != null);

  return (
    <FirmaSide titel={U.titel} intro={U.intro}>
      <Kort id="i-alt">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tal label={U.paaVej} vaerdi={krFraOere(o.udbetalinger.paa_vej_oere)} />
          <Tal label={U.udbetaltMaaned} vaerdi={krFraOere(o.udbetalinger.udbetalt_denne_maaned_oere)} />
          <Tal label={U.udbetalt} vaerdi={krFraOere(o.udbetalinger.udbetalt_i_alt_oere)} />
        </div>
        <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{U.hjaelp}</p>
      </Kort>

      <Kort id="pr-handel" titel={U.prHandel}>
        {salg.length === 0 ? (
          <p className={E_TEKST}>{U.tom}</p>
        ) : (
          <ul className="divide-y divide-kant rounded-[14px] border border-kant">
            {salg.map((s) => {
              const st = status(s);
              return (
                <li key={s.trade_id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-[19px] font-semibold break-words text-tekst">{s.titel ?? "Slettet auktion"}</p>
                    <p className={E_TEKST_DAEMPET}>
                      {langDato(s.overfoert_kl ?? s.betalt_kl ?? s.oprettet)} · {krFraOere(Number(s.udbetaling_oere))}
                    </p>
                  </div>
                  <StatusMaerke tekst={st.tekst} farve={st.farve} />
                </li>
              );
            })}
          </ul>
        )}
      </Kort>
    </FirmaSide>
  );
}
