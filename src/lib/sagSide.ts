import "server-only";

// Fælles opslag til siderne "Meld et problem" (/mine-handler/[id]/sag) og
// kvitteringen (/sag/sendt): handlen, varen og fristen. Med brugerens egen
// session (RLS) - kun køberen får noget tilbage.
import { createClient } from "@/lib/supabase/server";
import { hentKontoType } from "@/lib/supabase/bruger";
import { sagTidTilbage } from "@/lib/tekster/sagValg";
import { sagTid } from "@/components/sager/visning";
import type { SagFristVisning, SagVare } from "@/components/sager/meld/SagVareKort";

export type SagSideHandel = {
  id: string;
  sellerId: string;
  vare: SagVare;
  erhverv: boolean;
};

export async function hentSagSideHandel(tradeId: string, brugerId: string): Promise<SagSideHandel | null> {
  const supabase = await createClient();
  const { data: handel, error } = await supabase
    .from("trades")
    .select("id, auction_id, seller_id, buyer_id, amount")
    .eq("id", tradeId)
    .eq("buyer_id", brugerId)
    .maybeSingle<{ id: string; auction_id: string; seller_id: string; buyer_id: string; amount: number | string }>();
  if (error) throw new Error(`Handlen kunne ikke hentes: ${error.message}`);
  if (!handel) return null;

  const [{ data: auktion }, { data: saelger }, kontoType] = await Promise.all([
    supabase
      .from("auctions")
      .select("titel, billeder, erhverv")
      .eq("id", handel.auction_id)
      .maybeSingle<{ titel: string | null; billeder: string[] | null; erhverv: boolean | null }>(),
    supabase.from("users").select("visningsnavn").eq("id", handel.seller_id).maybeSingle<{ visningsnavn: string | null }>(),
    hentKontoType(handel.seller_id),
  ]);
  return {
    id: handel.id,
    sellerId: handel.seller_id,
    erhverv: auktion?.erhverv === true || kontoType === "erhverv",
    vare: {
      titel: auktion?.titel ?? "Slettet auktion",
      billede: auktion?.billeder?.[0] ?? null,
      beloeb: `${Number(handel.amount).toLocaleString("da-DK")} kr`,
      saelgerNavn: saelger?.visningsnavn ?? null,
    },
  };
}

// Fristen som "1 dag og 4 timer" + dato. Regnes på serveren, så server og
// browser viser det samme. null, når fristen er udløbet eller ikke findes.
export function sagFristVisning(fristKl: string | null): SagFristVisning | null {
  const tid = sagTidTilbage(fristKl, Date.now());
  if (!tid || !fristKl) return null;
  return { tid, dato: sagTid(fristKl) };
}
