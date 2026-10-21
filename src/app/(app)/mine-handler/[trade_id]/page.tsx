import type { Metadata } from "next";
import HandelDetalje from "@/components/handel/HandelDetalje";

// Handelssiden for private. Indholdet deles med firma-dashboardet
// (/firma/salg/[trade_id]) - se src/components/handel/HandelDetalje.tsx.
// Medlemskab tjekkes i layout.tsx og igen i HandelDetalje.

export const dynamic = "force-dynamic";
// Fragtlabel/returlabel (DAO) kan tage op til ca. 50 s i en server action (server.ts: OPRET_MAKS_MS_UDEN_OPSLAG).
export const maxDuration = 120;

export const metadata: Metadata = { title: "Handel", robots: { index: false, follow: false } };

export default async function HandelDetaljePage({
  params,
  searchParams,
}: {
  params: Promise<{ trade_id: string }>;
  searchParams: Promise<{ betaling?: string; vis?: string; returfragt?: string; ekstrafragt?: string; payment_intent?: string }>;
}) {
  const { trade_id } = await params;
  const { betaling, vis, returfragt, ekstrafragt, payment_intent } = await searchParams;
  return (
    <HandelDetalje
      trade_id={trade_id}
      betalingParam={betaling}
      visHandel={vis === "handel"}
      returfragtRetur={returfragt === "retur"}
      ekstraFragtParam={typeof ekstrafragt === "string" ? ekstrafragt : undefined}
      ekstraFragtPi={ekstrafragt === "retur" && typeof payment_intent === "string" ? payment_intent : undefined}
    />
  );
}
