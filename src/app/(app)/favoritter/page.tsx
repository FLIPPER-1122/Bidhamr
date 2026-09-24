import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AuctionCard from "@/components/AuctionCard";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";

export const dynamic = "force-dynamic";

// Auktionen hentes som embed på favoritten. Rækker hvor auktionen er slettet
// kommer tilbage med auctions = null og filtreres fra.
type FavoritRow = {
  auction_id: string;
  created_at: string;
  auctions: {
    id: string;
    titel: string;
    postnummer: string | null;
    lokation: string | null;
    nuværende_bud: number | string | null;
    startpris: number | string;
    oprettet: string;
    slutter_kl: string;
    billeder: string[] | null;
    skjult: boolean;
    bids: { count: number }[] | null;
  } | null;
};

export default async function FavoritterSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    redirect("/login?redirect=/favoritter");
  }

  // æ/ø i select-strengen (nuværende_bud) kollapser supabase-js' type til
  // ParserError, derfor det eksplicitte rowtype med overrideTypes.
  const { data } = await supabase
    .from("favorites")
    .select(
      "auction_id, created_at, auctions(id, titel, postnummer, lokation, nuværende_bud, startpris, oprettet, slutter_kl, billeder, skjult, bids(count))",
    )
    .order("created_at", { ascending: false })
    .overrideTypes<FavoritRow[], { merge: false }>();

  // Skjulte auktioner (fjernet af en moderator) vises ikke, selv om de stadig
  // ligger på favoritlisten.
  const auktioner = (data ?? [])
    .map((f) => f.auctions)
    .filter((a): a is NonNullable<FavoritRow["auctions"]> => !!a && !a.skjult)
    .map(mapAuctionTilKort);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Mine favoritter</h1>
        {auktioner.length > 0 && (
          <span className="text-sm text-neutral-500">
            {auktioner.length}{" "}
            {auktioner.length === 1 ? "auktion" : "auktioner"}
          </span>
        )}
      </div>

      {auktioner.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-neutral-300 px-6 py-16 text-center">
          <svg
            viewBox="0 0 24 24"
            className="mx-auto h-12 w-12 text-neutral-300"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 21s-7.5-4.5-9.5-9C1 8.5 2.5 5 6 5c2 0 3.5 1 4 2 0.5-1 2-2 4-2 3.5 0 5 3.5 3.5 7-2 4.5-9.5 9-9.5 9z"
            />
          </svg>
          <p className="mt-4 text-lg font-semibold text-neutral-900">
            Du har ingen favoritter endnu
          </p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-neutral-500">
            Tryk på hjertet på en auktion for at gemme den her, så du nemt kan
            finde den igen.
          </p>
          <Link
            href="/auktioner"
            className="mt-6 inline-block rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-mork"
          >
            Find auktioner
          </Link>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {auktioner.map((auktion) => (
            <AuctionCard key={auktion.id} auktion={auktion} />
          ))}
        </div>
      )}
    </main>
  );
}
