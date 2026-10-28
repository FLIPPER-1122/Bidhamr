import { hentFirmaFakturaer, kraevFirma } from "@/lib/erhverv/firmaData";
import { createClient } from "@/lib/supabase/server";
import { FirmaSide, Kort } from "@/components/firma/dele";
import FirmaFakturaIndstillingerForm from "@/components/firma/FirmaFakturaIndstillingerForm";
import { FIRMA_FAKTURA_TEKST as T } from "@/lib/erhverv/firmaFaktura";

// Præfiks, startnummer, standard-momsordning, betalingstekst, svar-e-mail
// og logo for fakturaerne fra firmaet til køberne.

export const dynamic = "force-dynamic";
export const metadata = { title: T.indstillinger };

export default async function FirmaFakturaIndstillingerSide() {
  const { bruger } = await kraevFirma("/firma/fakturaer/indstillinger");
  const liste = await hentFirmaFakturaer();
  if (!liste) throw new Error(T.fejl);
  const supabase = await createClient();
  const { data } = await supabase.from("firmaer").select("kontakt_email").eq("bruger_id", bruger.id).maybeSingle();
  const kontaktEmail = (data as { kontakt_email?: string } | null)?.kontakt_email ?? "";

  return (
    <FirmaSide titel={T.indstillinger} tilbage={{ href: "/firma/fakturaer", tekst: `Tilbage til ${T.titel.toLowerCase()}` }}>
      <Kort id="indstillinger">
        <FirmaFakturaIndstillingerForm i={liste.indstillinger} kontaktEmail={kontaktEmail} />
      </Kort>
    </FirmaSide>
  );
}
