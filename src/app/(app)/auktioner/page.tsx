import AuctionsExplorer from "@/components/AuctionsExplorer";
import { læsSortering } from "@/lib/sortering";
import { createClient } from "@/lib/supabase/server";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";

export default async function AuktionerPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kategori?: string; sortering?: string }>;
}) {
  const { q, kategori, sortering } = await searchParams;
  const søgetekst = q?.trim() ?? "";
  const initialKategori = kategori?.trim() ?? "";
  // ?sortering= fra forsiden og menuen ("Slutter snart", "Nye auktioner").
  const initialSortering = læsSortering(sortering);

  const supabase = await createClient();

  let query = supabase
    .from("auctions")
    .select("*")
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
    <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <h1 className="text-[26px] leading-tight break-words sm:text-[32px]">
        {søgetekst ? `Søgeresultater for "${søgetekst}"` : "Alle auktioner"}
      </h1>

      <AuctionsExplorer
        initialAuktioner={visteAuktioner}
        initialQuery={søgetekst}
        initialKategori={initialKategori}
        initialSortering={initialSortering}
      />
    </main>
  );
}
