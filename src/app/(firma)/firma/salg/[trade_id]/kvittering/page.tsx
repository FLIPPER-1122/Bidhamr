import Link from "next/link";
import { notFound } from "next/navigation";
import { kraevFirma } from "@/lib/erhverv/firmaData";
import { hentMinKvittering } from "@/lib/betaling/kvittering";
import { KvitteringFuld } from "@/components/Kvittering";
import UdskrivKnap from "@/components/UdskrivKnap";
import { FIRMA_DASHBOARD } from "@/lib/tekster/erhverv";

export const dynamic = "force-dynamic";

export const metadata = { title: "Afregning" };

// Udskrivbar afregning for firmaet (samme som /mine-handler/[id]/kvittering).
// hentMinKvittering tjekker, at brugeren er køber eller sælger i handlen.
export default async function FirmaKvittering({ params }: { params: Promise<{ trade_id: string }> }) {
  const { trade_id } = await params;
  await kraevFirma(`/firma/salg/${trade_id}/kvittering`);
  const kvittering = await hentMinKvittering(trade_id);
  if (!kvittering) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-6 print:p-0">
      {/* Kun indholdet udskrives - ikke top og menu. */}
      <style>{`@media print { body header, body nav { display: none !important; } }`}</style>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href={`/firma/salg/${trade_id}`}
          className="inline-flex min-h-12 items-center rounded-md text-[17px] font-semibold text-groen underline underline-offset-2"
        >
          ← {FIRMA_DASHBOARD.salg.knapSeHandel}
        </Link>
        <UdskrivKnap tekst="Udskriv eller gem som PDF" />
      </div>
      <KvitteringFuld k={kvittering} />
    </div>
  );
}
