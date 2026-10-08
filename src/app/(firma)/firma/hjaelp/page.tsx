import { kraevFirma } from "@/lib/erhverv/firmaData";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_KNAP_PRIMAER, E_TEKST } from "@/components/erhverv/stil";
import { FIRMA_DASHBOARD as D, FIRMA_OVERSIGT as T } from "@/lib/tekster/erhverv";

export const metadata = { title: D.hjaelp.titel };

export default async function FirmaHjaelp() {
  const { oversigt: o } = await kraevFirma("/firma/hjaelp");
  const email = o.kontakt_bidhamr || T.kontakt.email;

  return (
    <FirmaSide titel={D.hjaelp.titel}>
      <Kort id="kontakt" titel={T.kontakt.titel}>
        <p className={E_TEKST}>{T.kontakt.tekst}</p>
        <p className="mt-3 text-[22px] font-semibold break-all text-tekst">{email}</p>
        <a href={`mailto:${email}`} className={`${E_KNAP_PRIMAER} mt-5 w-full sm:w-auto`}>
          {T.kontakt.knap}
        </a>
      </Kort>
    </FirmaSide>
  );
}
