import AuctionsExplorer from "@/components/AuctionsExplorer";
import { createClient } from "@/lib/supabase/server";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";

export default async function AuktionerPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kategori?: string }>;
}) {
  const { q, kategori } = await searchParams;
  const søgetekst = q?.trim() ?? "";
  const initialKategori = kategori?.trim() ?? "";

  const supabase = await createClient();

  let query = supabase
    .from("auctions")
    .select("*, bids(count)")
    .eq("status", "aktiv")
    .eq("skjult", false)
    .gt("slutter_kl", new Date().toISOString())
    .order("slutter_kl", { ascending: true });

  if (søgetekst) {
    query = query.ilike("titel", `%${søgetekst}%`);
  }
  if (initialKategori) {
    query = query.eq("kategori", initialKategori);
  }

  const { data: auktioner, error } = await query;

  console.log("Auktioner hentet fra Supabase:", { auktioner, error });

  const visteAuktioner = (auktioner ?? []).map(mapAuctionTilKort);

  return (
    <main className="flex flex-1 flex-col bg-white px-4 py-6 sm:px-8">
      <h1 className="flex items-center gap-3 border-l-4 border-brand pl-3 text-2xl font-bold text-neutral-900 sm:text-3xl">
        {søgetekst
          ? `Søgeresultater for "${søgetekst}": ${visteAuktioner.length}`
          : `Alle auktioner lige nu: ${visteAuktioner.length}`}
      </h1>

      <div className="mt-4">
        <AuctionsExplorer
          initialAuktioner={visteAuktioner}
          initialQuery={søgetekst}
          initialKategori={initialKategori}
        />
      </div>
    </main>
  );
}
