import { kraevFirma } from "@/lib/erhverv/firmaData";
import PakkeValg, { PakkeInfo } from "@/components/erhverv/PakkeValg";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { FIRMA_OVERSIGT as T, FIRMA_OVERSIGT_EKSTRA as X } from "@/lib/tekster/erhverv";
import { langDato } from "@/lib/erhverv/visning";

// Abonnement: nuværende pakke og alle andre pakker med priser. Pakkeskift
// går gennem PakkeValg -> /api/offentlig/firma-skift-pakke (ikke en server
// action, så det også virker før lancering - se src/lib/supabase/middleware.ts).

export const metadata = { title: T.abonnement.titel };

export default async function FirmaAbonnement() {
  const { oversigt: o } = await kraevFirma("/firma/abonnement");
  const f = o.firma;
  const andrePakker = o.pakker.filter((p) => p.id !== o.pakke?.id);

  return (
    <FirmaSide titel={T.abonnement.titel} intro={T.abonnement.forklaring}>
      <Kort id="din-pakke" titel={T.abonnement.dinPakke}>
        {o.pakke ? (
          <div className="rounded-[14px] border-2 border-groen bg-groen-lys p-5">
            <PakkeInfo pakke={o.pakke} />
          </div>
        ) : (
          <p className={E_TEKST}>{X.ingenPakke}</p>
        )}

        {o.afventende_opgradering && (
          <div role="status" className="mt-4 rounded-[14px] border-2 border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst">
            <p className="text-[19px] font-semibold">{X.afventerTitel}</p>
            <p className="mt-1 text-[18px]">{X.afventerTekst(o.afventende_opgradering.navn)}</p>
          </div>
        )}
        {o.naeste_pakke && (
          <p role="status" className="mt-4 rounded-[14px] bg-info-bg p-4 text-[18px] text-info-tekst">
            {T.abonnement.planlagtSkift(o.naeste_pakke.navn, langDato(o.naeste_pakke.fra))}
          </p>
        )}
      </Kort>

      {o.pakke && andrePakker.length > 0 && (
        <Kort id="andre-pakker">
          <PakkeValg
            nuvaerende={o.pakke}
            andre={andrePakker}
            naestePeriode={langDato(f.betalt_til ?? f.naeste_periode)}
            kanSkifte={f.abonnement_status === "aktiv"}
            afventerId={o.afventende_opgradering?.id ?? null}
          />
          {f.abonnement_status !== "aktiv" && <p className={`mt-4 ${E_TEKST_DAEMPET}`}>{T.abonnement.betalingIkkeSatOpSkift}</p>}
        </Kort>
      )}
    </FirmaSide>
  );
}
