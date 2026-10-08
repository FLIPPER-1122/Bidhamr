import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { kraevFirma } from "@/lib/erhverv/firmaData";
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
  return <HandelDetalje trade_id={trade_id} sted="firma" />;
}
