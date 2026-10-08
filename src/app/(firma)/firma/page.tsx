import Link from "next/link";
import { kraevFirma } from "@/lib/erhverv/firmaData";
import { foerLancering } from "@/lib/lancering";
import { abonnementAktivt, ikkeAktivTekst, opretStatus } from "@/lib/erhverv/firmaStatus";
import { Advarsel, FirmaSide, Kort, LukketBoks, OpretKnap, Tal } from "@/components/firma/dele";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import {
  FIRMA_DASHBOARD as D,
  FIRMA_OVERSIGT as T,
  FIRMA_OVERSIGT_EKSTRA as X,
  FIRMA_BETALING,
} from "@/lib/tekster/erhverv";
import { kr, krFraOere } from "@/lib/erhverv/visning";

// Overblik (/firma): nøgletal og "Venter på dig" med store knapper direkte
// til handlingen. Resten har hver sin side i menuen (layout.tsx).
// Data: firma_oversigt (samme RPC som appen).

export const metadata = { title: D.overblik.titel };

export default async function FirmaOverblik() {
  const { oversigt: o } = await kraevFirma("/firma");
  const lukket = foerLancering();
  const k = o.ugekvote;
  const opret = opretStatus(o, lukket);
  const venter = o.venter_paa_dig;

  return (
    <FirmaSide titel={D.overblik.titel} intro={D.overblik.intro}>
      {lukket && <LukketBoks />}
      {!abonnementAktivt(o) && <Advarsel titel={T.ikkeAktiv.titel} tekst={ikkeAktivTekst(o)} />}
      {o.firma.abonnement_status === "afventer_betaling" && (
        <Link href="/firma/abonnement" className={`${E_KNAP_PRIMAER} w-full sm:w-auto`}>
          {FIRMA_BETALING.knapBetal}
        </Link>
      )}

      <Kort id="venter" titel={T.venter.titel} forklaring={T.venter.forklaring}>
        {venter.length === 0 ? (
          <p className={E_TEKST}>{T.venter.tom}</p>
        ) : (
          <ul className="space-y-4">
            {venter.map((v) => {
              const vare = v.titel ?? "varen";
              return (
                <li key={v.trade_id} className="rounded-[14px] border-2 border-orange bg-orange-lys p-4">
                  <p className={E_TEKST}>{v.afhentning ? X.afhentning(vare) : T.venter.sendPakke(vare)}</p>
                  {lukket ? (
                    <p className={`mt-2 ${E_TEKST_DAEMPET}`}>{D.salg.sendPakkeLukket}</p>
                  ) : (
                    <Link href={`/firma/salg/${v.trade_id}`} className={`${E_KNAP_PRIMAER} mt-3 w-full sm:w-auto`}>
                      {v.afhentning ? X.knapSeHandel : T.venter.knapSendPakke}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Kort>

      <Kort id="tal" titel={D.overblik.tal}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Tal label={T.overblik.denneMaaned} vaerdi={kr(o.salg.omsaetning_denne_maaned)} />
          <Tal label={T.overblik.iAlt} vaerdi={kr(o.salg.omsaetning_i_alt)} />
          <Tal label={D.overblik.aktive} vaerdi={o.auktioner.aktive.toLocaleString("da-DK")} />
          {k && <Tal label={D.overblik.ugensKvote} vaerdi={X.ugensTal(k.brugt, k.max)} />}
          <Tal label={T.overblik.paaVej} vaerdi={krFraOere(o.udbetalinger.paa_vej_oere)} />
          <Tal label={X.solgtIAlt} vaerdi={o.salg.solgte_i_alt.toLocaleString("da-DK")} />
        </div>
        {k && <p className={`mt-4 ${E_TEKST}`}>{D.auktioner.ugeKvote(k.brugt, k.max)}</p>}
        <div className="mt-5">
          <OpretKnap status={opret} />
        </div>
      </Kort>

      <nav aria-label={X.genvejeTitel} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Link href="/firma/auktioner" className={E_KNAP_SEKUNDAER}>
          {D.overblik.seAuktioner}
        </Link>
        <Link href="/firma/salg" className={E_KNAP_SEKUNDAER}>
          {D.overblik.seSalg}
        </Link>
        <Link href="/firma/udbetalinger" className={E_KNAP_SEKUNDAER}>
          {D.overblik.seUdbetalinger}
        </Link>
      </nav>
    </FirmaSide>
  );
}
