import Link from "next/link";
import { hentFirmaSalg, kraevFirma } from "@/lib/erhverv/firmaData";
import { foerLancering } from "@/lib/lancering";
import { salgStatus } from "@/lib/erhverv/firmaStatus";
import { FirmaSide, Kort, LukketBoks, StatusMaerke, VareBillede } from "@/components/firma/dele";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { FIRMA_DASHBOARD as D } from "@/lib/tekster/erhverv";
import { kr, langDato } from "@/lib/erhverv/visning";

// Salg: alle handler, hvor firmaet er sælger (firma_salg), med tydelig
// status. "Send pakke" og detaljer sker inde i dashboardet
// (/firma/salg/[trade_id]).

export const metadata = { title: D.salg.titel };

export default async function FirmaSalgSide() {
  await kraevFirma("/firma/salg");
  const salg = await hentFirmaSalg();
  const lukket = foerLancering();

  return (
    <FirmaSide titel={D.salg.titel} intro={D.salg.intro}>
      {lukket && <LukketBoks />}
      <Kort id="salg">
        {salg.length === 0 ? (
          <p className={E_TEKST}>{D.salg.tom}</p>
        ) : (
          <ul className="space-y-4">
            {salg.map((s) => {
              const st = salgStatus(s);
              return (
                <li key={s.trade_id} className="rounded-[14px] border-2 border-kant p-4">
                  <div className="flex gap-4">
                    <VareBillede url={s.billede} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[19px] leading-snug font-semibold break-words text-tekst">{s.titel ?? "Slettet auktion"}</p>
                      <p className={E_TEKST_DAEMPET}>
                        {D.salg.solgt} {langDato(s.oprettet)} · {kr(Number(s.beloeb))}
                      </p>
                      <div className="mt-2">
                        <StatusMaerke tekst={st.tekst} farve={st.farve} />
                      </div>
                    </div>
                  </div>
                  {!lukket && (
                    <Link
                      href={`/firma/salg/${s.trade_id}`}
                      className={`${st.handling && !s.afhentning ? E_KNAP_PRIMAER : E_KNAP_SEKUNDAER} mt-4 w-full sm:w-auto`}
                    >
                      {st.handling && !s.afhentning ? D.salg.knapSendPakke : D.salg.knapSeHandel}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Kort>
    </FirmaSide>
  );
}
