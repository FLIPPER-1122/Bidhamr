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
  FIRMA_FREMHAEV_KNAP as FV,
  FIRMA_ABONNEMENT as FA,
  FIRMA_UDBETALINGSKONTO as U,
} from "@/lib/tekster/erhverv";
import { kr, krFraOere } from "@/lib/erhverv/visning";
import { hentMineEkstraFragtRegninger } from "@/app/actions/ekstraFragt";
import EkstraFragtBjaelke from "@/components/ekstraFragt/EkstraFragtBjaelke";
import BankkontoOpgave from "@/components/firma/BankkontoOpgave";
import { hentUdbetalingskontostatus } from "@/lib/erhverv/udbetalingskonto";

// Overblik (/firma): nøgletal og "Venter på dig" med store knapper direkte
// til handlingen. Resten har hver sin side i menuen (layout.tsx).
// Data: firma_oversigt (samme RPC som appen).

export const metadata = { title: D.overblik.titel };

export default async function FirmaOverblik() {
  const [{ bruger, oversigt: o }, ekstraFragt] = await Promise.all([kraevFirma("/firma"), hentMineEkstraFragtRegninger()]);
  const lukket = foerLancering();
  const k = o.ugekvote;
  const venter = o.venter_paa_dig;
  // Uden færdig udbetalingskonto (bankkonto) kan firmaet hverken oprette
  // auktioner eller få penge udbetalt - det står øverst under "Venter på dig".
  const konto = await hentUdbetalingskontostatus(bruger.id);
  const kontoMangler = konto === "mangler" || konto === "ufaerdig";
  const opret0 = opretStatus(o, lukket);
  const opret = opret0.kan && kontoMangler ? { kan: false, forklaring: U.kanIkkeOprette } : opret0;
  // Ny firmakonto med gratis periode: "Start din gratis måned" i stedet for "Betal".
  const gratisStart = (o.abonnement?.gratis_maaneder_ved_start ?? 0) > 0;

  return (
    <FirmaSide titel={D.overblik.titel} intro={D.overblik.intro}>
      {lukket && <LukketBoks />}
      {/* Ubetalt ekstra fragt (for lille pakke) - knappen går direkte til betalingen. */}
      <EkstraFragtBjaelke regninger={ekstraFragt} firma />
      {!abonnementAktivt(o) && <Advarsel titel={T.ikkeAktiv.titel} tekst={ikkeAktivTekst(o)} />}
      {o.firma.abonnement_status === "afventer_betaling" && (
        <Link href="/firma/abonnement" className={`${E_KNAP_PRIMAER} w-full sm:w-auto`}>
          {gratisStart ? FA.gratisStartTitel : FA.knapStartAbonnement}
        </Link>
      )}

      <Kort id="venter" titel={T.venter.titel} forklaring={T.venter.forklaring}>
        {kontoMangler && !lukket && (
          <div className={venter.length > 0 ? "mb-4" : ""}>
            <BankkontoOpgave harKonto={konto === "ufaerdig"} />
          </div>
        )}
        {venter.length === 0 ? (
          kontoMangler && !lukket ? null : <p className={E_TEKST}>{T.venter.tom}</p>
        ) : (
          <ul className="space-y-4">
            {venter.map((v) => {
              const vare = v.titel ?? "varen";
              return (
                <li key={v.trade_id} className="rounded-none border-2 border-orange bg-orange-lys p-4">
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
          {k?.fremhaevninger && k.fremhaevninger.maks > 0 && (
            <Tal label={FV.talLabel} vaerdi={FV.tal(k.fremhaevninger.tilbage, k.fremhaevninger.maks)} />
          )}
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
