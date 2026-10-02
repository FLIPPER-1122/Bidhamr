import "server-only";

// Server-only hjælpere til sager: notifikationer. Bruges af server actions
// (src/app/actions/sager.ts, adminSager.ts) og cron.
import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { SAG_TYPE_NAVN, type SagType, erSagType, sagSti } from "@/lib/sager";

type Admin = ReturnType<typeof createAdminClient>;

async function handelOgTitel(admin: Admin, tradeId: string) {
  const { data: t } = await admin
    .from("trades")
    .select("buyer_id, seller_id, auction_id")
    .eq("id", tradeId)
    .maybeSingle<{ buyer_id: string; seller_id: string; auction_id: string }>();
  if (!t) return null;
  const { data: a } = await admin
    .from("auctions")
    .select("titel")
    .eq("id", t.auction_id)
    .maybeSingle();
  return { ...t, titel: (a?.titel as string | undefined) ?? "din vare" };
}

// "Sag oprettet" til køber og sælger. Claimes atomisk (sager.notificeret_kl),
// så den sendes præcis én gang - også for sager oprettet direkte fra appen
// (cron samler op). Kaster aldrig.
export async function notificerSagOprettet(sagId: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data: sag } = await admin
      .from("sager")
      .update({ notificeret_kl: new Date().toISOString() })
      .eq("id", sagId)
      .is("notificeret_kl", null)
      .select("id, trade_id, type")
      .maybeSingle<{ id: string; trade_id: string; type: string }>();
    if (!sag || !erSagType(sag.type)) return false;
    const h = await handelOgTitel(admin, sag.trade_id);
    if (!h) return false;
    const hvad = SAG_TYPE_NAVN[sag.type].toLowerCase();
    const link = sagSti(sag.trade_id);
    const data = { trade_id: sag.trade_id, sag_id: sag.id };
    await send(h.buyer_id, "sag", {
      titel: "Din sag er oprettet",
      tekst: `Vi har modtaget din sag om "${h.titel}" (${hvad}). Pengene holdes tilbage, mens BidHamr kigger på sagen.`,
      link,
      data,
      noegle: `sag_oprettet_koeber:${sag.id}`,
    });
    await send(h.seller_id, "sag", {
      titel: "Køberen har oprettet en sag",
      tekst: `Køberen har oprettet en sag om "${h.titel}" (${hvad}). Udbetalingen venter, til BidHamr har afgjort sagen.`,
      link,
      data,
      noegle: `sag_oprettet_saelger:${sag.id}`,
    });
    return true;
  } catch (err) {
    console.error("Notifikation om ny sag fejlede:", sagId, err);
    return false;
  }
}

// Cron: sager fra de seneste 7 dage, der ikke er notificeret endnu.
export async function notificerNyeSager(): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("sager")
    .select("id")
    .is("notificeret_kl", null)
    .gte("oprettet_kl", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .limit(100);
  if (error) {
    console.error("Hentning af nye sager fejlede:", error.message);
    return 0;
  }
  let antal = 0;
  for (const { id } of (data ?? []) as { id: string }[]) {
    if (await notificerSagOprettet(id)) antal++;
  }
  return antal;
}

export type SagUdfaldBesked =
  | "refunderet"
  | "afvent_retur"
  | "retur_afleveret"
  | "frigivet"
  | "saelger_medhold"
  | "lukket"
  | "genaabnet";

// Besked til køber og sælger efter en afgørelse. Begrundelsen fra staff
// medsendes (den er skrevet til parterne). Beløb nævnes aldrig. Kaster aldrig.
export async function notificerSagAfgoerelse(
  sagId: string,
  tradeId: string,
  type: SagType,
  udfald: SagUdfaldBesked,
  begrundelse: string | null,
  // sager.genaabnet_antal efter handlingen. Samme udfald kan kun ske igen
  // efter en genåbning, så nøglen er unik pr. afgørelse.
  version: number,
): Promise<void> {
  try {
    const admin = createAdminClient();
    const h = await handelOgTitel(admin, tradeId);
    if (!h) return;
    const link = sagSti(tradeId);
    const data = { trade_id: tradeId, sag_id: sagId };
    const grund = begrundelse ? ` Begrundelse: ${begrundelse}` : "";
    const t = h.titel;

    const tekster: Record<SagUdfaldBesked, { koeber: [string, string]; saelger: [string, string] }> = {
      refunderet: {
        koeber: ["Du har fået medhold i din sag", `BidHamr har afgjort sagen om "${t}" til din fordel. Du får pengene retur, undtagen BidHamr Beskyttelse.${grund}`],
        saelger: ["Sagen er afgjort", `BidHamr har afgjort sagen om "${t}" til køberens fordel. Køberen får pengene retur, og handlen er annulleret.${grund}`],
      },
      afvent_retur: {
        koeber: ["Send varen retur", `BidHamr har afgjort sagen om "${t}" til din fordel. Send varen retur til sælgeren - BidHamr betaler returfragten. Du får pengene retur, når returpakken er afleveret.${grund}`],
        saelger: ["Varen sendes retur", `BidHamr har afgjort sagen om "${t}" til køberens fordel. Køberen sender varen retur til dig - BidHamr betaler returfragten.${grund}`],
      },
      retur_afleveret: {
        koeber: ["Returpakken er afleveret", `Returpakken med "${t}" er afleveret. Du får nu pengene retur, undtagen BidHamr Beskyttelse.`],
        saelger: ["Returpakken er afleveret", `Returpakken med "${t}" er afleveret, og handlen er annulleret.`],
      },
      frigivet: {
        koeber: ["Sagen er afgjort", `BidHamr har afgjort sagen om "${t}" til sælgerens fordel. Pengene udbetales til sælgeren.${grund}`],
        saelger: ["Du har fået medhold i sagen", `BidHamr har afgjort sagen om "${t}" til din fordel. Pengene bliver udbetalt til din udbetalingskonto.${grund}`],
      },
      saelger_medhold: {
        koeber: ["Sagen er afgjort", `BidHamr har afgjort sagen om "${t}" til sælgerens fordel.${grund}`],
        saelger: ["Du har fået medhold i sagen", `BidHamr har afgjort sagen om "${t}" til din fordel. Udbetalingen sker, så snart betalingen er klar - BidHamr følger op.${grund}`],
      },
      lukket: {
        koeber: ["Sagen er lukket", `BidHamr har lukket sagen om "${t}". Handlen fortsætter som normalt.${grund}`],
        saelger: ["Sagen er lukket", `BidHamr har lukket sagen om "${t}". Handlen fortsætter som normalt.${grund}`],
      },
      genaabnet: {
        koeber: ["Sagen er genåbnet", `BidHamr har genåbnet sagen om "${t}". Pengene holdes tilbage, til sagen er afgjort igen.`],
        saelger: ["Sagen er genåbnet", `BidHamr har genåbnet sagen om "${t}". Udbetalingen venter, til sagen er afgjort igen.`],
      },
    };

    const tekst = tekster[udfald];
    await send(h.buyer_id, "sag", {
      titel: tekst.koeber[0],
      tekst: tekst.koeber[1],
      link,
      data,
      noegle: `sag_${udfald}_koeber:${sagId}:${version}`,
    });
    await send(h.seller_id, "sag", {
      titel: tekst.saelger[0],
      tekst: tekst.saelger[1],
      link,
      data,
      noegle: `sag_${udfald}_saelger:${sagId}:${version}`,
    });
  } catch (err) {
    console.error("Notifikation om afgørelse fejlede:", sagId, err);
  }
}
