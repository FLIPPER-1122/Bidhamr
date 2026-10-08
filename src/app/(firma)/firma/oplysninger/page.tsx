import { kraevFirma } from "@/lib/erhverv/firmaData";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_FEJL, E_HJAELP, E_KNAP_SEKUNDAER, E_TEKST } from "@/components/erhverv/stil";
import { FIRMA_DASHBOARD as D, FIRMA_OVERSIGT as T } from "@/lib/tekster/erhverv";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";
import { visTelefon } from "@/lib/erhverv/visning";

// Firmaoplysninger: kun læse. Rettelser sker hos BidHamr (sælger/chef i
// admin), så det stemmer med aftalen.

export const metadata = { title: T.firmaoplysninger.titel };

export default async function FirmaOplysninger({ searchParams }: { searchParams: Promise<{ data?: string }> }) {
  const { data: dataStatus } = await searchParams;
  const { oversigt: o } = await kraevFirma("/firma/oplysninger");
  const f = o.firma;
  const raekker: [string, string][] = [
    [T.firmaoplysninger.firmanavn, f.firmanavn],
    [T.firmaoplysninger.cvr, f.cvr],
    [T.firmaoplysninger.adresse, `${f.adresse}, ${f.postnummer} ${f.by}`],
    [T.firmaoplysninger.kontaktperson, f.kontaktperson],
    [T.firmaoplysninger.telefon, visTelefon(f.telefon)],
    [T.firmaoplysninger.email, f.kontakt_email],
  ];

  return (
    <FirmaSide titel={T.firmaoplysninger.titel} intro={T.firmaoplysninger.forklaring}>
      <Kort id="oplysninger">
        <dl className="space-y-4">
          {raekker.map(([label, vaerdi]) => (
            <div key={label}>
              <dt className="text-[17px] text-tekst-daempet">{label}</dt>
              <dd className={`${E_TEKST} font-semibold break-words`}>{vaerdi}</dd>
            </div>
          ))}
        </dl>
        <p className={`mt-6 ${E_TEKST}`}>
          {T.firmaoplysninger.rettes}{" "}
          <a
            href={`mailto:${ERHVERV_EMAIL}`}
            className="inline-flex min-h-11 items-center font-semibold break-all text-groen underline underline-offset-2"
          >
            {ERHVERV_EMAIL}
          </a>
        </p>
      </Kort>

      {/* "Download dine data" (GDPR): samme udtræk som /konto (mine_data).
          fra=firma sender en evt. fejl tilbage hertil (src/app/(app)/konto/data/route.ts). */}
      <div id="dine-data" className="scroll-mt-24">
        <Kort id="dine-data-titel" titel={D.dineData.titel} forklaring={D.dineData.tekst}>
          {(dataStatus === "vent" || dataStatus === "fejl") && (
            <p role="alert" className={`mb-4 ${E_FEJL}`}>
              {dataStatus === "vent" ? D.dineData.vent : D.dineData.fejl}
            </p>
          )}
          <form action="/konto/data" method="POST">
            <input type="hidden" name="fra" value="firma" />
            <button type="submit" className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
              {D.dineData.knap}
            </button>
          </form>
          <p className={E_HJAELP}>{D.dineData.hjaelp}</p>
        </Kort>
      </div>
    </FirmaSide>
  );
}
