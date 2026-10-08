import Link from "next/link";
import { kraevFirma } from "@/lib/erhverv/firmaData";
import { hentFirmaOversigt } from "@/app/actions/erhverv";
import { bekraeftCheckout } from "@/lib/erhverv/betaling";
import { logDriftFejl } from "@/lib/drift";
import PakkeValg, { PakkeInfo } from "@/components/erhverv/PakkeValg";
import StripeKnap from "@/components/erhverv/StripeKnap";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { FIRMA_BETALING as B, FIRMA_OVERSIGT as T, FIRMA_OVERSIGT_EKSTRA as X } from "@/lib/tekster/erhverv";
import { kr, krFraOere, langDato } from "@/lib/erhverv/visning";
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
    <div role={farve === "fejl" ? "alert" : "status"} className={`rounded-[18px] border-2 p-5 ${klasser}`}>
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
  const pauseFra = f.betaling_mislykket_kl
    ? new Date(new Date(f.betaling_mislykket_kl).getTime() + 7 * 24 * 3600 * 1000).toISOString()
    : null;

  return (
    <FirmaSide titel={T.abonnement.titel} intro={T.abonnement.forklaring}>
      {retur === "betalt" && <Boks farve="succes" titel={B.kvitteringTitel} tekst={B.kvitteringTekst} />}
      {retur === "behandles" && <Boks farve="info" titel={B.behandlesTitel} tekst={B.behandlesTekst} />}
      {retur === "afbrudt" && kanStarte && <Boks farve="info" titel={B.betalTitel} tekst={B.afbrudtTekst} />}

      {kanStarte && (
        <Kort id="betal" titel={f.abonnement_status === "pauset" ? B.pauseTitel : B.betalTitel}>
          <p className={E_TEKST}>
            {f.abonnement_status === "pauset"
              ? B.pauseNyBetalingTekst
              : pakke?.maanedspris != null
                ? B.betalTekst(pakke.navn, kr(pakke.maanedspris))
                : B.betalTekstUdenPris}
          </p>
          {pakke?.maanedspris != null && (
            <p className="mt-3 text-[20px] font-semibold text-tekst">
              {B.prisMedMoms(
                krFraOere(oereInklMoms(pakke.maanedspris).ekskl),
                krFraOere(oereInklMoms(pakke.maanedspris).inkl),
              )}
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
          <div className="rounded-[14px] border-2 border-groen bg-groen-lys p-5">
            <PakkeInfo pakke={pakke} />
          </div>
        ) : (
          <p className={E_TEKST}>{X.ingenPakke}</p>
        )}

        {f.har_stripe_abonnement && f.abonnement_status === "aktiv" && !f.opsiges_fra && f.periode_slut && (
          <p className={`mt-4 ${E_TEKST}`}>{B.naesteBetaling(langDato(f.periode_slut))}</p>
        )}
        {f.opsiges_fra && (
          <p role="status" className="mt-4 rounded-[14px] bg-info-bg p-4 text-[18px] text-info-tekst">
            {B.opsigesTekst(langDato(f.opsiges_fra))}
          </p>
        )}

        {o.afventende_opgradering && (
          <div role="status" className="mt-4 rounded-[14px] border-2 border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst">
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
          <p role="status" className="mt-4 rounded-[14px] bg-info-bg p-4 text-[18px] text-info-tekst">
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
          />
          {f.abonnement_status !== "aktiv" && <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{T.abonnement.betalingIkkeSatOpSkift}</p>}
        </Kort>
      )}

      {f.har_stripe_abonnement && (
        <Kort id="betalingskort" titel={B.knapSkiftKort}>
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
