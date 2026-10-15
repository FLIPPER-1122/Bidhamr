import "server-only";

// Handlens status til appen (POST /api/handel/app/status): de oplysninger,
// hjemmesidens handelsside (src/components/handel/HandelDetalje.tsx) henter
// på serveren, fordi brugeren ikke selv kan læse dem (betalinger-kolonner,
// ubetalte_vindere, handel_ikke_afhentet og sager er kun for service-role).
// Samme funktioner som hjemmesiden - ingen ny logik.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { hentAfsendelsesfristAnnullering } from "@/lib/betaling/afsendelsesfrist";
import { hentAfhentningsfristAnnullering } from "@/lib/betaling/afhentningsfrist";
import { hentIkkeAfhentet } from "@/lib/betaling/ikkeAfhentet";
import { hentBetalingsstatusFor } from "@/lib/betaling/betalingsstatus";
import { fragtLabelsAktiv, fragtReturlabelAktiv } from "@/lib/fragt";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Blev handlen annulleret, fordi køberen ikke betalte (eller BidHamr
// annullerede den før betaling)? Kun til køber og sælger på handlen
// (brugerId er den indloggede bruger, verificeret af kalderen). Fælles for
// erAnnulleretUbetalt (hjemmesiden) og appens status.
export async function annulleretUbetaltAarsag(
  tradeId: string,
  brugerId: string,
): Promise<"ubetalt" | "admin_annulleret" | null> {
  try {
    if (!UUID.test(tradeId)) return null;
    const { data } = await createAdminClient()
      .from("ubetalte_vindere")
      .select("id, aarsag")
      .eq("trade_id", tradeId)
      .or(`buyer_id.eq.${brugerId},seller_id.eq.${brugerId}`)
      .maybeSingle();
    if (!data) return null;
    return data.aarsag === "admin_annulleret" ? "admin_annulleret" : "ubetalt";
  } catch (err) {
    console.error("annulleretUbetaltAarsag fejlede:", err);
    return null;
  }
}

export type AnnulleringsAarsag =
  | "ubetalt"
  | "admin_annulleret"
  | "afsendelsesfrist"
  | "afhentningsfrist"
  | "ikke_afhentet"
  | "sag";

export type HandelAppStatus = {
  annullering: { aarsag: AnnulleringsAarsag | null; refunderet: boolean } | null;
  betaling: { sidsteFejl: boolean } | null;
  fragt: { labelsAktiv: boolean; returlabelAktiv: boolean };
};

type Handel = { id: string; status: string; afhentning: boolean };

// Er betalingen refunderet? (Til annulleringer uden egen visning.)
async function betalingRefunderet(tradeId: string, brugerId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("betalinger")
    .select("status")
    .eq("trade_id", tradeId)
    .or(`buyer_id.eq.${brugerId},seller_id.eq.${brugerId}`)
    .maybeSingle<{ status: string }>();
  return data?.status === "refunderet";
}

async function harSag(tradeId: string): Promise<boolean> {
  const { data } = await createAdminClient().from("sager").select("id").eq("trade_id", tradeId).limit(1);
  return (data?.length ?? 0) > 0;
}

// handel SKAL være hentet med et partsfilter (brugeren er køber eller
// sælger) af kalderen. supabase kalder databasen SOM brugeren.
export async function hentHandelAppStatus(
  supabase: SupabaseClient,
  brugerId: string,
  handel: Handel,
): Promise<HandelAppStatus> {
  const annulleret = handel.status === "annulleret";
  const fragt = { labelsAktiv: fragtLabelsAktiv(), returlabelAktiv: fragtReturlabelAktiv() };

  // Betalingen hentes kun, mens der ventes på den (som handelssiden). Kun
  // køberen kan se et mislykket betalingsforsøg.
  let betaling: HandelAppStatus["betaling"] = null;
  if (handel.status === "afventer_betaling") {
    const b = await hentBetalingsstatusFor(supabase, brugerId, handel.id);
    if ("ok" in b) betaling = { sidsteFejl: b.erKoeber ? Boolean(b.sidsteFejl) : false };
  }

  if (!annulleret) return { annullering: null, betaling, fragt };

  // Samme opslag og samme rækkefølge som handelssiden.
  const [ubetalt, afsendelse, afhentning, ikkeAfhentet] = await Promise.all([
    annulleretUbetaltAarsag(handel.id, brugerId),
    hentAfsendelsesfristAnnullering(handel.id, brugerId),
    handel.afhentning ? hentAfhentningsfristAnnullering(handel.id, brugerId) : Promise.resolve(null),
    handel.afhentning ? Promise.resolve(null) : hentIkkeAfhentet(handel.id, brugerId),
  ]);

  let annullering: HandelAppStatus["annullering"];
  if (ubetalt) annullering = { aarsag: ubetalt, refunderet: await betalingRefunderet(handel.id, brugerId) };
  else if (afsendelse) annullering = { aarsag: "afsendelsesfrist", refunderet: afsendelse.refunderet };
  else if (afhentning) annullering = { aarsag: "afhentningsfrist", refunderet: afhentning.refunderet };
  else if (ikkeAfhentet) annullering = { aarsag: "ikke_afhentet", refunderet: ikkeAfhentet.refunderet };
  else if (await harSag(handel.id)) annullering = { aarsag: "sag", refunderet: await betalingRefunderet(handel.id, brugerId) };
  else annullering = { aarsag: null, refunderet: await betalingRefunderet(handel.id, brugerId) };

  return { annullering, betaling, fragt };
}
