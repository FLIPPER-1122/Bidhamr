import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentMinKvittering } from "@/lib/betaling/kvittering";
import { KvitteringFuld } from "@/components/Kvittering";
import UdskrivKnap from "@/components/UdskrivKnap";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Kvittering",
  robots: { index: false, follow: false },
};

// Udskrivbar kvittering (køber, når betalingen er modtaget) eller afregning
// (sælger, når pengene er frigivet). hentMinKvittering tjekker, at brugeren
// er køber eller sælger i handlen, og giver kun brugerens egne beløb.
export default async function KvitteringPage({
  params,
}: {
  params: Promise<{ trade_id: string }>;
}) {
  const { trade_id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirect=/mine-handler/${trade_id}/kvittering`);

  const kvittering = await hentMinKvittering(trade_id);
  if (!kvittering) notFound();

  return (
    <main className="flex-1 px-4 pt-4 pb-8 sm:px-6 lg:px-8 lg:pt-6 lg:pb-10 print:p-0">
      {/* Kun sidens indhold udskrives - ikke menu og sidefod. */}
      <style>{`@media print { body header, body footer { display: none !important; } }`}</style>
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <Link
            href={`/mine-handler/${trade_id}`}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-tekst-daempet hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Tilbage til handlen
          </Link>
          <UdskrivKnap tekst="Udskriv eller gem som PDF" />
        </div>
        <KvitteringFuld k={kvittering} />
      </div>
    </main>
  );
}
