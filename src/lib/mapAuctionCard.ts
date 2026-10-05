import type { DummyAuction } from "@/components/AuctionCard";
import { beregnProcentForløbet, formatTidTilbage } from "@/lib/auctionTid";

const EN_TIME_MS = 60 * 60 * 1000;

function erUnderEnTime(slutterKl: string) {
  const tilbage = new Date(slutterKl).getTime() - Date.now();
  return tilbage > 0 && tilbage < EN_TIME_MS;
}

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
  // Vedligeholdes af en trigger paa bids (bud kan ikke taelles direkte, da
  // de ikke er offentlige).
  antal_bud?: number | null;
}

export function mapAuctionTilKort(
  auktion: AuctionRowMedBudCount,
): DummyAuction {
  return {
    id: auktion.id,
    titel: auktion.titel,
    lokation: auktion.lokation ?? auktion.postnummer ?? "Ukendt",
    nuværendeBud: Number(auktion.nuværende_bud ?? auktion.startpris),
    antalBud: auktion.antal_bud ?? 0,
    tidTilbage: formatTidTilbage(auktion.slutter_kl),
    procentForløbet: beregnProcentForløbet(auktion.oprettet, auktion.slutter_kl),
    slutterSnart: erUnderEnTime(auktion.slutter_kl),
    billede: auktion.billeder?.[0] ?? null,
  };
}
