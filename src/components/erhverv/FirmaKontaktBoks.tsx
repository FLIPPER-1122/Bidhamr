import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { FirmaOffentlig } from "@/lib/erhverv/regler";
import { telefonLink, visTelefon } from "@/lib/erhverv/visning";
import { ERHVERVSSAELGER, FIRMA_DASHBOARD } from "@/lib/tekster/erhverv";

// Firmaets kontaktoplysninger (firma_offentlig - kan læses af alle) på
// handelssiden for køberen, i stedet for chatten (Ingen beskeder med
// erhvervssælgere, Filip 8. okt. 2026).
export default async function FirmaKontaktBoks({ saelgerId }: { saelgerId: string }) {
  const supabase = await createClient();
  const { data } = await supabase.rpc("firma_offentlig", { p_bruger: saelgerId });
  const firma = (data as FirmaOffentlig | null) ?? null;
  const K = FIRMA_DASHBOARD.koeberKontakt;

  return (
    <section aria-labelledby="firma-kontakt" className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
      <h2 id="firma-kontakt" className="text-[20px] leading-tight">
        {K.titel}
      </h2>
      <p className="mt-1 text-[16px] text-tekst-daempet">{K.tekst}</p>
      {firma && (
        <dl className="mt-4 space-y-3 text-[17px]">
          <div>
            <dt className="text-tekst-daempet">{ERHVERVSSAELGER.firmanavn}</dt>
            <dd className="font-semibold break-words text-tekst">{firma.firmanavn}</dd>
          </div>
          {firma.telefon && (
            <div>
              <dt className="text-tekst-daempet">{K.telefon}</dt>
              <dd>
                <a href={telefonLink(firma.telefon)} className="inline-flex min-h-11 items-center font-semibold text-groen underline underline-offset-2">
                  {visTelefon(firma.telefon)}
                </a>
              </dd>
            </div>
          )}
          {firma.kontakt_email && (
            <div>
              <dt className="text-tekst-daempet">{K.email}</dt>
              <dd>
                <a href={`mailto:${firma.kontakt_email}`} className="inline-flex min-h-11 items-center font-semibold break-all text-groen underline underline-offset-2">
                  {firma.kontakt_email}
                </a>
              </dd>
            </div>
          )}
        </dl>
      )}
      <Link
        href={`/erhvervssaelger/${saelgerId}`}
        className="btn btn-sekundaer btn-stor mt-4 w-full text-[17px] sm:w-auto"
      >
        {K.seProfil}
      </Link>
    </section>
  );
}
