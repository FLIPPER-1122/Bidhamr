import "server-only";

// Server-only: automatisk frigivelse til sælgeren (ROADMAP-BESLUTNINGER
// "Sager (Filip, 3. oktober 2026)"):
//   - 48 timer efter køberen trykkede "modtaget", uden sag.
//   - 14 dage efter afsendelse, hvis køberen hverken har trykket "modtaget"
//     eller oprettet en sag (indtil GLS-sporing erstatter det).
// Databasen afgør og frigiver atomisk (handel_auto_frigiv - respekterer
// frysning, åbne/afgjorte sager, indsigelse og refusion). Bagefter overføres
// pengene som ved køberens godkendelse (overfoerTilSaelger), og køberen får
// besked. Sælgeren får "Din udbetaling er på vej" fra overførslen (eller
// påmindelsen om udbetalingskonto). Kaster aldrig.
import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { overfoerTilSaelger } from "@/lib/betaling/stripeBetaling";

type AutoFrigivet = {
  betaling_id: string;
  trade_id: string;
  buyer_id: string;
  seller_id: string;
  auction_id: string;
  grund: "48_timer" | "14_dage";
};

export async function frigivAutomatisk(): Promise<number> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("handel_auto_frigiv");
  if (error) {
    console.error("handel_auto_frigiv fejlede:", error.message);
    return 0;
  }
  const liste = (Array.isArray(data) ? data : []) as AutoFrigivet[];
  if (liste.length === 0) return 0;

  const { data: auktioner } = await admin
    .from("auctions")
    .select("id, titel")
    .in("id", [...new Set(liste.map((f) => f.auction_id))]);
  const titler = new Map((auktioner ?? []).map((a) => [a.id as string, a.titel as string]));

  for (const f of liste) {
    try {
      await overfoerTilSaelger(f.betaling_id);
    } catch (err) {
      console.error("Overførsel efter automatisk frigivelse fejlede (cron prøver igen):", f.betaling_id, err);
    }
    const titel = titler.get(f.auction_id) ?? "din vare";
    await send(f.buyer_id, "pakke_leveret", {
      titel: "Handlen er afsluttet",
      tekst:
        f.grund === "48_timer"
          ? `Der er gået 48 timer, siden du modtog "${titel}", uden at der er oprettet en sag. Handlen er afsluttet, og pengene er frigivet til sælgeren.`
          : `Der er gået 14 dage, siden sælgeren sendte "${titel}", uden at du har markeret pakken som modtaget eller oprettet en sag. Handlen er afsluttet automatisk, og pengene er frigivet til sælgeren.`,
      link: `/mine-handler/${f.trade_id}`,
      data: { trade_id: f.trade_id },
      noegle: `auto_frigivet:${f.trade_id}`,
    });
  }
  return liste.length;
}
