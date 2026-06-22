import type { DummyAuction } from "@/components/AuctionCard";
import { beregnProcentForløbet, formatTidTilbage } from "@/lib/auctionTid";

interface AuctionRowMedBudCount {
  id: string;
  titel: string;
  postnummer: string | null;
  lokation: string | null;
  nuværende_bud: number | string | null;
  startpris: number | string;
  oprettet: string;
  slutter_kl: string;
  billeder: string[] | null;
  bids?: { count: number }[] | null;
}

export function mapAuctionTilKort(
  auktion: AuctionRowMedBudCount,
): DummyAuction {
  return {
    id: auktion.id,
    titel: auktion.titel,
    lokation: auktion.lokation ?? auktion.postnummer ?? "Ukendt",
    nuværendeBud: Number(auktion.nuværende_bud ?? auktion.startpris),
    antalBud: auktion.bids?.[0]?.count ?? 0,
    tidTilbage: formatTidTilbage(auktion.slutter_kl),
    procentForløbet: beregnProcentForløbet(auktion.oprettet, auktion.slutter_kl),
    billede: auktion.billeder?.[0] ?? null,
  };
}
