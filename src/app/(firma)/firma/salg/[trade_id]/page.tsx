import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hentFirmaFakturaSalg, kraevFirma } from "@/lib/erhverv/firmaData";
import { Kort } from "@/components/firma/dele";
import { FakturaOplysningerListe } from "@/components/firma/FakturaOplysninger";
import { FAKTURA_TEKST } from "@/lib/erhverv/fakturaOplysninger";
import HandelDetalje from "@/components/handel/HandelDetalje";
import { FIRMA_DASHBOARD } from "@/lib/tekster/erhverv";

// En handel inde i firma-dashboardet: samme handelsside som /mine-handler
// (trin, "Send pakke" med pakkebilleder og fragtlabel, kvittering), men uden
// chat (Ingen beskeder med erhvervssælgere). Medlemskab tjekkes i
// HandelDetalje (kun køber/sælger - ellers 404).

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metadata: Metadata = { title: FIRMA_DASHBOARD.salg.titel };

export default async function FirmaHandel({ params }: { params: Promise<{ trade_id: string }> }) {
  const { trade_id } = await params;
  await kraevFirma(`/firma/salg/${trade_id}`);
  if (!UUID.test(trade_id)) notFound();
  // Oplysninger til firmaets egen faktura (kun firmaets egne, betalte salg -
  // firma_faktura_salg filtrerer på auth.uid()).
  const faktura = await hentFirmaFakturaSalg(null, null, trade_id);
  const salg = faktura?.salg[0];
  return (
    <>
      <HandelDetalje trade_id={trade_id} sted="firma" />
      {faktura && salg && (
        <div className="mx-auto mt-6 max-w-3xl">
          <Kort id="faktura-oplysninger" titel={FAKTURA_TEKST.titel} forklaring={FAKTURA_TEKST.forklaring}>
            <FakturaOplysningerListe salg={salg} firma={faktura.firma} />
          </Kort>
        </div>
      )}
    </>
  );
}
