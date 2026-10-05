import AuctionsExplorer from "@/components/AuctionsExplorer";
import { læsSortering } from "@/lib/sortering";
import { createClient } from "@/lib/supabase/server";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";
import type { Metadata } from "next";
import { kategorier } from "@/lib/kategorier";

// Kategorisider er egne sider i søgemaskinerne; fritekstsøgninger indekseres
// ikke (uendeligt mange varianter af samme indhold).
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kategori?: string }>;
}): Promise<Metadata> {
  const { q, kategori } = await searchParams;
  const søg = q?.trim() ?? "";
  const kat = kategorier.find((k) => k === kategori?.trim());
  if (søg) {
    return {
      title: `Søgning: ${søg.slice(0, 60)}`,
      robots: { index: false, follow: true },
      alternates: { canonical: "/auktioner" },
    };
  }
  if (kat) {
    return {
      title: `${kat} på auktion`,
      description: `Byd på brugt ${kat.toLowerCase()} fra private sælgere i hele Danmark. Trygt med BidHamr Beskyttelse.`,
      alternates: { canonical: `/auktioner?kategori=${encodeURIComponent(kat)}` },
    };
  }
  return {
    title: "Alle auktioner",
    description:
      "Se alle auktioner på BidHamr lige nu. Find brugte ting fra private sælgere, og byd trygt med BidHamr Beskyttelse.",
    alternates: { canonical: "/auktioner" },
  };
}

export default async function AuktionerPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kategori?: string; sortering?: string }>;
}) {
  const { q, kategori, sortering } = await searchParams;
  const søgetekst = q?.trim() ?? "";
  // Kun kendte kategorier – ukendte værdier ignoreres (som i generateMetadata).
  const initialKategori = kategorier.find((k) => k === kategori?.trim()) ?? "";
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

  if (error) console.error("Auktioner kunne ikke hentes:", error.message);

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
