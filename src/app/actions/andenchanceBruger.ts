"use server";

// Små opslag til brugerens egne sider (Mine handler). Supplerer
// andenchance.ts uden at ændre den.

import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AktivtTilbud = { id: string; udloeber: string; titel: string };

// Byderens ventende andenchance-tilbud. Hentes med brugerens egen nøgle:
// RLS lader kun byderen selv læse rækken.
export async function hentMineAktiveTilbud(): Promise<AktivtTilbud[]> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return [];

    const { data } = await supabase
      .from("andenchance_tilbud")
      .select("id, auction_id, udloeber")
      .eq("byder_id", user.id)
      .eq("status", "afventer")
      .gt("udloeber", new Date().toISOString())
      .order("udloeber", { ascending: true })
      .limit(10);
    const raekker = data ?? [];
    if (raekker.length === 0) return [];

    // Auktionen kan være skjult; byderen har adgang via tilbuddet.
    const { data: auktioner } = await createAdminClient()
      .from("auctions")
      .select("id, titel")
      .in("id", raekker.map((r) => r.auction_id as string));
    const titler = new Map((auktioner ?? []).map((a) => [a.id as string, a.titel as string]));

    return raekker.map((r) => ({
      id: r.id as string,
      udloeber: r.udloeber as string,
      titel: titler.get(r.auction_id as string) ?? "Vare",
    }));
  } catch (err) {
    console.error("hentMineAktiveTilbud fejlede:", err);
    return [];
  }
}

// Til køberen af en annulleret handel: blev den annulleret, fordi køberen
// ikke betalte? Sagstabellen er kun for service-role, så det tjekkes her.
// Returnerer årsagen ("ubetalt" | "admin_annulleret"), eller null.
export async function erAnnulleretUbetalt(
  tradeId: string,
): Promise<"ubetalt" | "admin_annulleret" | null> {
  try {
    if (!UUID.test(tradeId)) return null;
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return null;

    const { data } = await createAdminClient()
      .from("ubetalte_vindere")
      .select("id, aarsag")
      .eq("trade_id", tradeId)
      .eq("buyer_id", user.id)
      .maybeSingle();
    if (!data) return null;
    return data.aarsag === "admin_annulleret" ? "admin_annulleret" : "ubetalt";
  } catch (err) {
    console.error("erAnnulleretUbetalt fejlede:", err);
    return null;
  }
}
