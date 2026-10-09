// Fakturaerne for én handel på handelssiden (købers og sælgers egne - også i
// firma-dashboardet). Viser intet, før der er en faktura.
import { createClient } from "@/lib/supabase/server";
import { hentMineFakturaer } from "@/lib/faktura/data";
import { FAKTURA_TEKST as T } from "@/lib/faktura/tekster";
import FakturaListe from "@/components/faktura/FakturaListe";

export default async function FakturaBoks({ tradeId }: { tradeId: string }) {
  const supabase = await createClient();
  const fakturaer = await hentMineFakturaer(supabase, tradeId);
  if (!fakturaer || fakturaer.length === 0) return null;
  return (
    <section aria-labelledby={`fakturaer-${tradeId}`} className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
      <h2 id={`fakturaer-${tradeId}`} className="text-[17px] leading-snug lg:text-lg">
        {T.boksTitel}
      </h2>
      <p className="mt-1 text-sm text-tekst-daempet">{T.boksIntro}</p>
      <div className="mt-3">
        <FakturaListe fakturaer={fakturaer} visHandel={false} />
      </div>
    </section>
  );
}
