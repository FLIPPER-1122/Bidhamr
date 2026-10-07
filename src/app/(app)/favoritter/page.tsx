import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AuctionCard from "@/components/AuctionCard";
import TomTilstand from "@/components/TomTilstand";
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
    arkiveret_kl: string | null;
    antal_bud: number | null;
    erhverv: boolean | null;
  } | null;
};

export const metadata: Metadata = { title: "Favoritter", robots: { index: false, follow: false } };

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
      "auction_id, created_at, auctions(id, titel, postnummer, lokation, nuværende_bud, startpris, oprettet, slutter_kl, billeder, skjult, arkiveret_kl, antal_bud, erhverv)",
    )
    .order("created_at", { ascending: false })
    .overrideTypes<FavoritRow[], { merge: false }>();

  // Skjulte auktioner (fjernet af en moderator) og arkiverede auktioner
  // (afsluttet handel for over 48 timer siden) vises ikke, selv om de stadig
  // ligger på favoritlisten. RLS skjuler arkiverede for alle andre end
  // parterne; her fjernes de også for parterne.
  const auktioner = (data ?? [])
    .map((f) => f.auctions)
    .filter((a): a is NonNullable<FavoritRow["auctions"]> => !!a && !a.skjult && !a.arkiveret_kl)
    .map(mapAuctionTilKort);

  return (
    <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-[26px] leading-tight sm:text-[32px]">Mine favoritter</h1>
        {auktioner.length > 0 && (
          <span className="text-sm text-tekst-svag">
            {auktioner.length}{" "}
            {auktioner.length === 1 ? "auktion" : "auktioner"}
          </span>
        )}
      </div>

      {auktioner.length === 0 ? (
        <TomTilstand
          className="mt-6"
          ikon="hjerte"
          titel="Du har ingen favoritter endnu"
          tekst="Tryk på hjertet på en auktion for at gemme den her, så du nemt kan finde den igen."
          knap={{ href: "/auktioner", tekst: "Find auktioner" }}
        />
      ) : (
        <ul className="mt-6 grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-3 xl:grid-cols-4">
          {auktioner.map((auktion) => (
            <li key={auktion.id} className="min-w-0">
              <AuctionCard auktion={auktion} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
