import AuctionCard from "@/components/AuctionCard";
import { createClient } from "@/lib/supabase/server";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";

export default async function Home() {
  const supabase = await createClient();

  const { data: auktioner, error } = await supabase
    .from("auctions")
    .select("*, bids(count)")
    .eq("status", "aktiv")
    .gt("slutter_kl", new Date().toISOString())
    .order("oprettet", { ascending: false });

  console.log("Auktioner hentet fra Supabase:", { auktioner, error });

  const visteAuktioner = (auktioner ?? []).map(mapAuctionTilKort);

  const lokationer = Array.from(
    new Set(visteAuktioner.map((a) => a.lokation)),
  );

  return (
    <main className="flex flex-1 flex-col bg-white px-4 py-6 sm:px-8">
      <h1 className="flex items-center gap-3 border-l-4 border-brand pl-3 text-2xl font-bold text-neutral-900 sm:text-3xl">
        Alle auktioner lige nu: {visteAuktioner.length}
      </h1>

      <div className="mt-4 flex flex-col gap-3 bg-[#F3F4F6] px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
        <select
          defaultValue=""
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        >
          <option value="">Alle lokationer</option>
          {lokationer.map((lokation) => (
            <option key={lokation} value={lokation}>
              {lokation}
            </option>
          ))}
        </select>

        <select
          defaultValue="udløber"
          className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        >
          <option value="udløber">Udløber snart</option>
          <option value="hoejest">Højeste bud</option>
          <option value="nyeste">Nyeste</option>
        </select>
      </div>

      {visteAuktioner.length === 0 ? (
        <p className="mt-10 text-center text-sm text-neutral-500">
          Ingen aktive auktioner lige nu.
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {visteAuktioner.map((auktion) => (
            <AuctionCard key={auktion.id} auktion={auktion} />
          ))}
        </div>
      )}
    </main>
  );
}
