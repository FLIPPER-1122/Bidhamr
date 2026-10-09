import type { Metadata } from "next";
import HandelDetalje from "@/components/handel/HandelDetalje";

// Handelssiden for private. Indholdet deles med firma-dashboardet
// (/firma/salg/[trade_id]) - se src/components/handel/HandelDetalje.tsx.
// Medlemskab tjekkes i layout.tsx og igen i HandelDetalje.

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Handel", robots: { index: false, follow: false } };

export default async function HandelDetaljePage({
  params,
  searchParams,
}: {
  params: Promise<{ trade_id: string }>;
  searchParams: Promise<{ betaling?: string; vis?: string }>;
}) {
  const { trade_id } = await params;
  const { betaling, vis } = await searchParams;
  return <HandelDetalje trade_id={trade_id} betalingParam={betaling} visHandel={vis === "handel"} />;
}
