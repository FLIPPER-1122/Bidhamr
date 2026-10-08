import { kraevFirma } from "@/lib/erhverv/firmaData";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_TEKST } from "@/components/erhverv/stil";
import { FIRMA_OVERSIGT as T } from "@/lib/tekster/erhverv";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";
import { visTelefon } from "@/lib/erhverv/visning";

// Firmaoplysninger: kun læse. Rettelser sker hos BidHamr (sælger/chef i
// admin), så det stemmer med aftalen.

export const metadata = { title: T.firmaoplysninger.titel };

export default async function FirmaOplysninger() {
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
    </FirmaSide>
  );
}
