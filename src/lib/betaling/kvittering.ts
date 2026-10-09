import "server-only";

// Henter data til kvitteringen (køber) og afregningen (sælger) for en handel.
// Læser via service-role, fordi saelgergebyr_oere/udbetaling_oere og
// refusionsfelterne ikke kan læses med brugerens JWT (kolonne-grants).
// Kalderen afgør, hvem der må se hvad:
//   - mails: modtageren er selv køber/sælger i handlen.
//   - handelssiden: hentMinKvittering tjekker medlemskab med brugerens JWT
//     og giver kun brugerens egen del.
// Køberens kvittering vises først, når betalingen er modtaget; sælgerens
// afregning først, når pengene er frigivet. Sælgeren får aldrig køberens
// gebyr, fragt eller BidHamr Beskyttelse at se.
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { KoeberKvittering, Kvittering, SaelgerKvittering } from "@/lib/kvittering";

type Raekke = {
  trade_id: string;
  auction_id: string;
  buyer_id: string;
  seller_id: string;
  bud_oere: number;
  koebergebyr_oere: number;
  fragt_oere: number;
  beskyttelse: boolean;
  beskyttelse_oere: number;
  total_oere: number;
  saelgergebyr_oere: number;
  udbetaling_oere: number;
  status: string;
  betalt_kl: string | null;
  frigivet_kl: string | null;
  overfoert_kl: string | null;
  refusion_oere: number | null;
  refunderet_kl: string | null;
  refusion_anmodet_kl: string | null;
};

const KOLONNER =
  "trade_id, auction_id, buyer_id, seller_id, bud_oere, koebergebyr_oere, fragt_oere, " +
  "beskyttelse, beskyttelse_oere, total_oere, saelgergebyr_oere, udbetaling_oere, status, " +
  "betalt_kl, frigivet_kl, overfoert_kl, refusion_oere, refunderet_kl, refusion_anmodet_kl";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// null, når der (endnu) ikke er en kvittering til rollen.
export async function bygKvittering(
  tradeId: string,
  rolle: "koeber" | "saelger",
): Promise<Kvittering | null> {
  if (!UUID.test(tradeId)) return null;
  const admin = createAdminClient();
  const { data: b, error } = await admin
    .from("betalinger")
    .select(KOLONNER)
    .eq("trade_id", tradeId)
    .maybeSingle<Raekke>();
  if (error) {
    console.error("Kvittering: betalingen kunne ikke hentes:", tradeId, error.message);
    return null;
  }
  if (!b || !b.betalt_kl) return null;
  if (rolle === "koeber" && b.status !== "betalt" && b.status !== "refunderet") return null;
  // Afregning kun for en frigivet handel, hvor pengene ikke er på vej
  // tilbage til køberen.
  if (
    rolle === "saelger" &&
    (!b.frigivet_kl || b.status !== "betalt" || b.refusion_anmodet_kl)
  ) {
    return null;
  }

  const modpartId = rolle === "koeber" ? b.seller_id : b.buyer_id;
  const [{ data: a }, { data: t }, { data: u }, { data: fm }] = await Promise.all([
    admin
      .from("auctions")
      .select("titel, erhverv")
      .eq("id", b.auction_id)
      .maybeSingle<{ titel: string | null; erhverv: boolean | null }>(),
    admin.from("trades").select("afhentning").eq("id", tradeId).maybeSingle<{ afhentning: boolean | null }>(),
    admin.from("users").select("navn").eq("id", modpartId).maybeSingle<{ navn: string | null }>(),
    // Firmasalg: sælgeren har en firmakonto (firmaer-rækken findes kun for
    // erhvervskonti). Firmaet sender selv fakturaen på varen.
    admin
      .from("firmaer")
      .select("firmanavn, cvr")
      .eq("bruger_id", b.seller_id)
      .maybeSingle<{ firmanavn: string; cvr: string }>(),
  ]);
  const firma = fm ? { firmanavn: fm.firmanavn, cvr: fm.cvr } : null;
  const titel = a?.titel ?? "Vare";
  const modpartNavn = u?.navn?.trim() || (rolle === "koeber" ? "Sælgeren" : "Køberen");
  const afhentning = t?.afhentning === true;

  if (rolle === "koeber") {
    const refunderet = b.status === "refunderet";
    const k: KoeberKvittering = {
      rolle: "koeber",
      handelId: tradeId,
      titel,
      modpartNavn,
      dato: b.betalt_kl,
      afhentning,
      budOere: Number(b.bud_oere),
      koebergebyrOere: Number(b.koebergebyr_oere),
      fragtOere: Number(b.fragt_oere),
      beskyttelse: b.beskyttelse,
      beskyttelseOere: Number(b.beskyttelse_oere),
      totalOere: Number(b.total_oere),
      refunderetOere: refunderet ? Number(b.refusion_oere ?? b.total_oere) : null,
      refunderetKl: refunderet ? b.refunderet_kl : null,
      firma,
    };
    return k;
  }

  const k: SaelgerKvittering = {
    rolle: "saelger",
    handelId: tradeId,
    titel,
    modpartNavn,
    dato: b.frigivet_kl!,
    afhentning,
    budOere: Number(b.bud_oere),
    saelgergebyrOere: Number(b.saelgergebyr_oere),
    udbetalingOere: Number(b.udbetaling_oere),
    overfoertKl: b.overfoert_kl,
    firma,
  };
  return k;
}

// Til handelssiden: den indloggede brugers egen kvittering for handlen.
// Medlemskab tjekkes med brugerens JWT og eksplicit filter (RLS slipper også
// staff igennem). Rollen udledes af auth.uid() - aldrig fra klienten.
export async function hentMinKvittering(tradeId: string): Promise<Kvittering | null> {
  if (!UUID.test(tradeId)) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: handel } = await supabase
    .from("trades")
    .select("buyer_id, seller_id")
    .eq("id", tradeId)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .maybeSingle<{ buyer_id: string; seller_id: string }>();
  if (!handel) return null;
  if (handel.buyer_id === user.id) return bygKvittering(tradeId, "koeber");
  if (handel.seller_id === user.id) return bygKvittering(tradeId, "saelger");
  return null;
}
