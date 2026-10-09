import Link from "next/link";
import { hentFirmaFakturaSalg, hentFirmaSalg, kraevFirma } from "@/lib/erhverv/firmaData";
import { foerLancering } from "@/lib/lancering";
import { salgStatus } from "@/lib/erhverv/firmaStatus";
import { FirmaSide, Kort, LukketBoks, StatusMaerke, VareBillede } from "@/components/firma/dele";
import {
  E_HJAELP,
  E_KNAP_PRIMAER,
  E_KNAP_SEKUNDAER,
  E_LABEL,
  E_TEKST,
  E_TEKST_DAEMPET,
  eFelt,
} from "@/components/erhverv/stil";
import { FIRMA_DASHBOARD as D } from "@/lib/tekster/erhverv";
import { kr, langDato } from "@/lib/erhverv/visning";
import { FakturaOplysningerFold } from "@/components/firma/FakturaOplysninger";
import { FAKTURA_TEKST } from "@/lib/erhverv/fakturaOplysninger";

// Salg: alle handler, hvor firmaet er sælger (firma_salg), med tydelig
// status. "Send pakke" og detaljer sker inde i dashboardet
// (/firma/salg/[trade_id]).

export const metadata = { title: D.salg.titel };

export default async function FirmaSalgSide() {
  await kraevFirma("/firma/salg");
  const [salg, faktura] = await Promise.all([hentFirmaSalg(), hentFirmaFakturaSalg()]);
  const lukket = foerLancering();
  // Oplysninger til firmaets egen faktura (kun betalte salg).
  const fakturaPrHandel = new Map((faktura?.salg ?? []).map((f) => [f.trade_id, f]));
  const idag = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
  const maanedStart = `${idag.slice(0, 8)}01`;

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
                  {faktura && fakturaPrHandel.get(s.trade_id) ? (
                    <FakturaOplysningerFold salg={fakturaPrHandel.get(s.trade_id)!} firma={faktura.firma} />
                  ) : (
                    s.status !== "annulleret" && <p className={`mt-3 ${E_HJAELP}`}>{FAKTURA_TEKST.ikkeBetalt}</p>
                  )}
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
      {salg.length > 0 && (
        <Kort id="eksport" titel={FAKTURA_TEKST.eksportTitel} forklaring={FAKTURA_TEKST.eksportForklaring}>
          <p className={`mb-4 ${E_TEKST}`}>{FAKTURA_TEKST.forklaring}</p>
          <form action="/firma/salg/eksport" method="GET" className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div>
              <label htmlFor="eksport-fra" className={E_LABEL}>
                {FAKTURA_TEKST.fra}
              </label>
              <input id="eksport-fra" name="fra" type="date" required defaultValue={maanedStart} max={idag} className={eFelt()} />
            </div>
            <div>
              <label htmlFor="eksport-til" className={E_LABEL}>
                {FAKTURA_TEKST.til}
              </label>
              <input id="eksport-til" name="til" type="date" required defaultValue={idag} className={eFelt()} />
            </div>
            <button type="submit" className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
              {FAKTURA_TEKST.eksportKnap}
            </button>
          </form>
        </Kort>
      )}
    </FirmaSide>
  );
}
