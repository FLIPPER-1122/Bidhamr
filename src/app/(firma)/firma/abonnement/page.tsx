import Link from "next/link";
import { kraevFirma } from "@/lib/erhverv/firmaData";
import { hentFirmaOversigt } from "@/app/actions/erhverv";
import { bekraeftCheckout } from "@/lib/erhverv/betaling";
import { logDriftFejl } from "@/lib/drift";
import PakkeValg, { PakkeInfo } from "@/components/erhverv/PakkeValg";
import StripeKnap from "@/components/erhverv/StripeKnap";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import {
  FIRMA_ABONNEMENT as FA,
  FIRMA_BETALING as B,
  FIRMA_OVERSIGT as T,
  FIRMA_OVERSIGT_EKSTRA as X,
} from "@/lib/tekster/erhverv";
import { kr, krFraOere, langDato } from "@/lib/erhverv/visning";
import { plusMaaneder } from "@/lib/erhverv/abonnementRegler";
import type { FirmaOversigt } from "@/lib/erhverv/regler";

// Abonnement: betaling (Stripe Billing), nuværende pakke og alle andre
// pakker med priser (ekskl. moms). Alle knapper går via /api/offentlig (ikke
// server actions), så det også virker før lancering - se
// src/lib/supabase/middleware.ts.
//   ?betaling=ok&session=cs_...  retur fra Stripe Checkout (kvittering)
//   ?betaling=afbrudt            firmaet afbrød betalingen

export const metadata = { title: T.abonnement.titel };

// Moms regnes i hele øre som i Stripe (fast Tax Rate 25 %, eksklusiv):
// momsen afrundes til nærmeste øre og lægges oven i prisen.
function oereInklMoms(maanedspris: number): { ekskl: number; inkl: number } {
  const ekskl = Math.round(maanedspris * 100);
  return { ekskl, inkl: ekskl + Math.round((ekskl * 25) / 100) };
}

function Boks({ titel, tekst, farve, children }: { titel: string; tekst?: string; farve: "succes" | "advarsel" | "info" | "fejl"; children?: React.ReactNode }) {
  const klasser = {
    succes: "border-succes-kant bg-succes-bg text-succes-tekst",
    advarsel: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst",
    info: "border-info-kant bg-info-bg text-info-tekst",
    fejl: "border-fejl-kant bg-fejl-bg text-fejl-tekst",
  }[farve];
  return (
    <div role={farve === "fejl" ? "alert" : "status"} className={`rounded-none border-2 p-5 ${klasser}`}>
      <p className="text-[21px] font-semibold">{titel}</p>
      {tekst && <p className="mt-1 text-[18px]">{tekst}</p>}
      {children && <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{children}</div>}
    </div>
  );
}

// Den seneste abonnementsregning, der ikke er betalt (til "Betal regningen").
function ubetaltRegning(o: FirmaOversigt): string | null {
  const r = o.regninger.find(
    (x) => x.type === "abonnement" && (x.status === "mislykket" || x.status === "afventer") && x.hosted_url?.startsWith("https://"),
  );
  return r?.hosted_url ?? null;
}

export default async function FirmaAbonnement({
  searchParams,
}: {
  searchParams: Promise<{ betaling?: string; session?: string }>;
}) {
  const { bruger, oversigt } = await kraevFirma("/firma/abonnement");
  const sp = await searchParams;
  let o = oversigt;

  // Retur fra Stripe Checkout: spejl betalingen med det samme (webhooken gør
  // det samme - begge er idempotente), så kvitteringen passer.
  let retur: "betalt" | "behandles" | "ukendt" | "afbrudt" | null = sp.betaling === "afbrudt" ? "afbrudt" : null;
  if (sp.betaling === "ok" && typeof sp.session === "string") {
    try {
      retur = await bekraeftCheckout(bruger.id, sp.session);
    } catch (err) {
      await logDriftFejl({ kilde: "server", hvor: "firma/abonnement/bekraeftCheckout", fejl: err, brugerId: bruger.id });
      retur = "behandles";
    }
    if (retur === "betalt") {
      const frisk = await hentFirmaOversigt();
      if ("ok" in frisk && frisk.oversigt) o = frisk.oversigt;
    }
  }

  const f = o.firma;
  const pakke = o.pakke;
  const andrePakker = o.pakker.filter((p) => p.id !== pakke?.id);
  const kanStarte =
    !f.har_stripe_abonnement &&
    (f.abonnement_status === "afventer_betaling" || (f.abonnement_status === "pauset" && f.pauset_aarsag === "betaling"));
  const ubetalt = ubetaltRegning(o);

  // Pris, gratis periode og introrabat (erhverv_firma_abonnement_json).
  // eslint-disable-next-line react-hooks/purity -- serverkomponent: tidspunktet for denne visning
  const nu = Date.now();
  const ab = o.abonnement;
  const pris = ab?.pris ?? pakke?.maanedspris ?? null;
  const gratisTil = ab?.gratis_til && new Date(ab.gratis_til).getTime() > nu ? ab.gratis_til : null;
  const gratisVedStart = ab?.gratis_maaneder_ved_start ?? 0;
  const intro = ab?.introrabat ?? null;
  // intro_status kan ikke bruges (står altid 'aktiv') - intro_til afgør det:
  // ingen slutdato = ikke startet endnu, slutdato i fremtiden = kører.
  const introKoerer = !!intro?.til && new Date(intro.til).getTime() > nu;
  const introPlanlagt = !!intro && !intro.til;
  const introPris = pris != null && intro && (introKoerer || introPlanlagt) ? (pris * (100 - intro.procent)) / 100 : null;
  // Første betaling efter de gratis måneder (Checkout sætter trial_end ud fra
  // samme antal måneder).
  const foersteBetaling = gratisVedStart > 0 ? langDato(new Date(plusMaaneder(Math.floor(nu / 1000), gratisVedStart) * 1000).toISOString()) : null;
  const foerstePris = intro && introPlanlagt && intro.fra === "efter_gratis" && introPris != null ? introPris : pris;
  const pauseFra = f.betaling_mislykket_kl
    ? new Date(new Date(f.betaling_mislykket_kl).getTime() + 7 * 24 * 3600 * 1000).toISOString()
    : null;

  return (
    <FirmaSide titel={T.abonnement.titel} intro={T.abonnement.forklaring}>
      {retur === "betalt" &&
        (gratisTil ? (
          <Boks farve="succes" titel={FA.kvitteringGratisTitel} tekst={FA.kvitteringGratisTekst(langDato(gratisTil))} />
        ) : (
          <Boks farve="succes" titel={B.kvitteringTitel} tekst={B.kvitteringTekst} />
        ))}
      {retur === "behandles" && <Boks farve="info" titel={B.behandlesTitel} tekst={B.behandlesTekst} />}
      {retur === "afbrudt" && kanStarte && <Boks farve="info" titel={B.betalTitel} tekst={B.afbrudtTekst} />}

      {kanStarte && gratisVedStart > 0 && f.abonnement_status !== "pauset" && (
        <Kort id="betal" titel={FA.gratisStartTitel}>
          <p className={E_TEKST}>{FA.gratisStartTekst(gratisVedStart)}</p>
          <p className="mt-3 text-[20px] font-semibold text-tekst">{FA.iDag}</p>
          {foersteBetaling && foerstePris != null && (
            <p className={`mt-2 ${E_TEKST}`}>
              {FA.gratisFoersteBetaling(
                foersteBetaling,
                B.prisMedMoms(krFraOere(oereInklMoms(foerstePris).ekskl), krFraOere(oereInklMoms(foerstePris).inkl)),
              )}
            </p>
          )}
          {intro && introPlanlagt && (
            <p className={`mt-2 ${E_TEKST}`}>{FA.introPlanlagt(intro.procent, intro.maaneder, intro.fra === "efter_gratis")}</p>
          )}
          <p className={`mt-2 ${E_TEKST_DAEMPET}`}>{B.ingenGebyr}</p>
          <div className="mt-5">
            <StripeKnap handling="firma-betal" tekst={FA.knapStartGratis} />
          </div>
          <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{B.stripeForklaring}</p>
        </Kort>
      )}

      {kanStarte && !(gratisVedStart > 0 && f.abonnement_status !== "pauset") && (
        <Kort id="betal" titel={f.abonnement_status === "pauset" ? B.pauseTitel : B.betalTitel}>
          <p className={E_TEKST}>
            {f.abonnement_status === "pauset"
              ? B.pauseNyBetalingTekst
              : pakke && pris != null
                ? B.betalTekst(pakke.navn, kr(pris))
                : B.betalTekstUdenPris}
          </p>
          {pris != null && (
            <p className="mt-3 text-[20px] font-semibold text-tekst">
              {B.prisMedMoms(krFraOere(oereInklMoms(pris).ekskl), krFraOere(oereInklMoms(pris).inkl))}
            </p>
          )}
          <p className={`mt-2 ${E_TEKST_DAEMPET}`}>{B.maanedligTekst}</p>
          <div className="mt-5">
            <StripeKnap handling="firma-betal" tekst={B.knapBetal} />
          </div>
          <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{B.stripeForklaring}</p>
        </Kort>
      )}

      {f.har_stripe_abonnement && f.abonnement_status === "aktiv" && f.betaling_mislykket_kl && pauseFra && (
        <Boks farve="fejl" titel={B.mislykketTitel} tekst={B.mislykketTekst(langDato(pauseFra))}>
          {ubetalt && (
            <a href={ubetalt} className={E_KNAP_PRIMAER} rel="noopener noreferrer">
              {B.knapBetalRegning}
            </a>
          )}
          <StripeKnap handling="firma-betalingskort" tekst={B.knapSkiftKort} primaer={!ubetalt} />
        </Boks>
      )}

      {f.har_stripe_abonnement && f.abonnement_status === "pauset" && f.pauset_aarsag === "betaling" && (
        <Boks farve="fejl" titel={B.pauseTitel} tekst={B.pauseTekst}>
          {ubetalt && (
            <a href={ubetalt} className={E_KNAP_PRIMAER} rel="noopener noreferrer">
              {B.knapBetalRegning}
            </a>
          )}
          <StripeKnap handling="firma-betalingskort" tekst={B.knapSkiftKort} primaer={!ubetalt} />
        </Boks>
      )}

      <Kort id="din-pakke" titel={T.abonnement.dinPakke}>
        {pakke ? (
          <div className="rounded-none border-2 border-groen bg-groen-lys p-5">
            <PakkeInfo pakke={pakke} />
          </div>
        ) : (
          <p className={E_TEKST}>{X.ingenPakke}</p>
        )}

        {pakke && ab?.saerpris != null && pakke.maanedspris != null && (
          <p className={`mt-4 ${E_TEKST}`}>{FA.saerpris(kr(ab.saerpris), kr(pakke.maanedspris))}</p>
        )}
        {intro && introKoerer && intro.til && <p className={`mt-4 ${E_TEKST}`}>{B.introrabat(intro.procent, langDato(intro.til))}</p>}
        {intro && introPlanlagt && f.har_stripe_abonnement && (
          <p className={`mt-4 ${E_TEKST}`}>{FA.introPlanlagt(intro.procent, intro.maaneder, intro.fra === "efter_gratis")}</p>
        )}
        {introPris != null && f.har_stripe_abonnement && <p className={`mt-1 ${E_TEKST}`}>{FA.introPris(krFraOere(Math.round(introPris * 100)))}</p>}
        {gratisTil && <p className={`mt-4 ${E_TEKST}`}>{FA.gratisNu(langDato(gratisTil))}</p>}
        {f.har_stripe_abonnement && f.abonnement_status === "aktiv" && !f.opsiges_fra && f.periode_slut && !gratisTil && (
          <p className={`mt-4 ${E_TEKST}`}>{B.naesteBetaling(langDato(f.periode_slut))}</p>
        )}
        <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{B.ingenGebyr}</p>
        {f.opsiges_fra && (
          <p role="status" className="mt-4 rounded-none bg-info-bg p-4 text-[18px] text-info-tekst">
            {B.opsigesTekst(langDato(f.opsiges_fra))}
          </p>
        )}

        {o.afventende_opgradering && (
          <div role="status" className="mt-4 rounded-none border-2 border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst">
            <p className="text-[19px] font-semibold">{X.afventerTitel}</p>
            <p className="mt-1 text-[18px]">{X.afventerTekst(o.afventende_opgradering.navn)}</p>
            {o.afventende_opgradering.faktura_url?.startsWith("https://") && (
              <a href={o.afventende_opgradering.faktura_url} className={`${E_KNAP_PRIMAER} mt-4 w-full sm:w-auto`} rel="noopener noreferrer">
                {B.knapBetalForskellen}
              </a>
            )}
          </div>
        )}
        {o.naeste_pakke && (
          <p role="status" className="mt-4 rounded-none bg-info-bg p-4 text-[18px] text-info-tekst">
            {T.abonnement.planlagtSkift(o.naeste_pakke.navn, langDato(o.naeste_pakke.fra))}
          </p>
        )}
      </Kort>

      {pakke && andrePakker.length > 0 && (
        <Kort id="andre-pakker">
          <PakkeValg
            nuvaerende={pakke}
            andre={andrePakker}
            naestePeriode={langDato(f.periode_slut ?? f.betalt_til ?? f.naeste_periode)}
            kanSkifte={f.abonnement_status === "aktiv" && !f.opsiges_fra}
            afventerId={o.afventende_opgradering?.id ?? null}
            iGratisPeriode={!!gratisTil}
          />
          {f.abonnement_status !== "aktiv" && <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{T.abonnement.betalingIkkeSatOpSkift}</p>}
        </Kort>
      )}

      {f.har_stripe_abonnement && (
        <Kort id="betalingskort" titel={ab?.kort ? FA.kortTitel : B.knapSkiftKort}>
          {ab?.kort && (
            <p className={`mb-3 ${E_TEKST} font-semibold`}>
              {FA.kort(`${ab.kort.maerke ? `${ab.kort.maerke.toUpperCase()} ` : ""}•••• ${ab.kort.sidste4}`, ab.kort.udloeb)}
            </p>
          )}
          {ab?.kort?.udloeber_snart && (
            <p role="status" className="mb-3 border-2 border-advarsel-kant bg-advarsel-bg p-4 text-[18px] text-advarsel-tekst">
              {FA.kortUdloeberSnart}
            </p>
          )}
          <p className={E_TEKST}>{B.skiftKortTekst}</p>
          <div className="mt-4">
            <StripeKnap handling="firma-betalingskort" tekst={B.knapSkiftKort} primaer={false} />
          </div>
          <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{B.stripeForklaring}</p>
        </Kort>
      )}

      <div>
        <Link href="/firma/regninger" className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
          {T.regninger.titel}
        </Link>
      </div>
    </FirmaSide>
  );
}
