import "server-only";

// Server-only: automatisk frigivelse til sælgeren (ROADMAP-BESLUTNINGER
// "Sager (Filip, 3. oktober 2026)"):
//   - fristen efter "modtaget" (trades.problem_frist_kl: 72 t; 48 t for ældre handler), uden sag - køberen trykkede selv, eller
//     fragtfirmaets leveringsmelding startede uret (fragtUr.ts,
//     trades.modtaget_kilde = 'fragt').
//   - 14 dage efter afsendelse, hvis køberen hverken har trykket "modtaget"
//     eller oprettet en sag - KUN når pakken er sendt med BidHamrs fragtlabel
//     og fragtfirmaet har meldt den leveret/afhentet (Filip, 11. okt. 2026).
//     Ellers får staff en opgave, og pengene frigives aldrig automatisk
//     (handel_auto_frigiv, 20261019010000).
// Databasen afgør og frigiver atomisk (handel_auto_frigiv - respekterer
// frysning, åbne/afgjorte sager, indsigelse og refusion). Bagefter udbetales
// pengene som ved køberens godkendelse (pengeTilSaelger), og køberen får
// besked. Sælgeren får afregningen (med grunden) og "Din udbetaling er på
// vej" fra overførslen (eller påmindelsen om udbetalingskonto). Kaster aldrig.
import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { indsigelseBlokerer } from "@/lib/betaling/stripeBetaling";
import { pengeTilSaelger } from "@/lib/betaling/udbetaling";
import { sendSaelgerAfregning } from "@/lib/betaling/handelsbeskeder";
import { SAG_AUTO_FRIGIV_EFTER_DAGE } from "@/lib/sager";

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

  const [{ data: auktioner }, { data: fraFragt }] = await Promise.all([
    admin
      .from("auctions")
      .select("id, titel")
      .in("id", [...new Set(liste.map((f) => f.auction_id))]),
    // Uret blev startet af fragtfirmaets leveringsmelding (fragtUr.ts).
    admin
      .from("trades")
      .select("id")
      .in("id", liste.map((f) => f.trade_id))
      .eq("modtaget_kilde", "fragt"),
  ]);
  const titler = new Map((auktioner ?? []).map((a) => [a.id as string, a.titel as string]));
  const fragt = new Set((fraFragt ?? []).map((t) => t.id as string));

  for (const f of liste) {
    const viaFragt = f.grund === "48_timer" && fragt.has(f.trade_id);
    // Før overførslen, så afregningen får grunden med (kaster aldrig).
    await sendSaelgerAfregning(
      f.trade_id,
      viaFragt ? "automatisk_fragt" : f.grund === "48_timer" ? "automatisk_48" : "automatisk_14",
    );
    try {
      await pengeTilSaelger(f.betaling_id);
    } catch (err) {
      console.error("Overførsel efter automatisk frigivelse fejlede (cron prøver igen):", f.betaling_id, err);
    }
    const titel = titler.get(f.auction_id) ?? "din vare";
    await send(f.buyer_id, "pakke_leveret", {
      titel: "Handlen er afsluttet",
      tekst: viaFragt
        ? `Fristen for at melde et problem med "${titel}" er udløbet, uden at der er meldt et problem. Handlen er afsluttet, og pengene er frigivet til sælgeren.`
        : f.grund === "48_timer"
          ? `Fristen for at melde et problem med "${titel}" er udløbet, uden at der er meldt et problem. Handlen er afsluttet, og pengene er frigivet til sælgeren.`
          : `Der er gået 14 dage, siden sælgeren sendte "${titel}", uden at du har markeret pakken som modtaget eller oprettet en sag. Handlen er afsluttet automatisk, og pengene er frigivet til sælgeren.`,
      link: `/mine-handler/${f.trade_id}`,
      data: { trade_id: f.trade_id },
      noegle: `auto_frigivet:${f.trade_id}`,
    });
  }
  return liste.length;
}

const DAG = 24 * 60 * 60 * 1000;
// Påmindelsen sendes 12 dage efter afsendelse - 2 dage før den automatiske
// frigivelse (SAG_AUTO_FRIGIV_EFTER_DAGE).
const PAAMIND_EFTER_DAGE = 12;

function datoTekst(ms: number): string {
  return new Date(ms).toLocaleDateString("da-DK", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Copenhagen",
  });
}

// Påmindelse til køberen 12 dage efter afsendelse, når pakken ikke er
// markeret som modtaget, og der ikke er oprettet en sag: ellers udbetales
// pengene automatisk til sælgeren (handel_auto_frigiv, dag 14). Kun handler,
// hvor betalingen er betalt og hverken frigivet, overført eller under
// refusion, og uden en blokerende indsigelse hos køberens bank (samme regel
// som betaling_indsigelse_blokerer - så frigives intet automatisk, og
// påmindelsen ville være forkert). Idempotent: nøglen `paamind_modtaget:<handel>` sendes kun én gang.
// Kaster aldrig.
export async function paamindKoeberOmModtagelse(): Promise<number> {
  try {
    const admin = createAdminClient();
    const nu = Date.now();
    const { data: handler, error } = await admin
      .from("trades")
      .select("id, buyer_id, auction_id, sendt_kl")
      .eq("status", "pakke_sendt")
      .not("sendt_kl", "is", null)
      .lte("sendt_kl", new Date(nu - PAAMIND_EFTER_DAGE * DAG).toISOString())
      .gt("sendt_kl", new Date(nu - SAG_AUTO_FRIGIV_EFTER_DAGE * DAG).toISOString())
      .or("sag_aaben.is.null,sag_aaben.eq.false")
      .limit(200);
    if (error) {
      console.error("Hentning af handler til påmindelse om modtagelse fejlede:", error.message);
      return 0;
    }
    const liste = (handler ?? []) as {
      id: string;
      buyer_id: string;
      auction_id: string;
      sendt_kl: string;
    }[];
    if (liste.length === 0) return 0;
    const ids = liste.map((t) => t.id);

    const [{ data: sager }, { data: betalinger }, { data: auktioner }, { data: retur }, { data: leveret }] = await Promise.all([
      admin.from("sager").select("trade_id").in("trade_id", ids),
      admin
        .from("betalinger")
        .select("trade_id, indsigelse_kl, indsigelse_status")
        .in("trade_id", ids)
        .eq("status", "betalt")
        .is("frigivet_kl", null)
        .is("refusion_anmodet_kl", null)
        .is("overfoersel_paabegyndt_kl", null)
        .is("stripe_transfer_id", null),
      admin
        .from("auctions")
        .select("id, titel")
        .in("id", [...new Set(liste.map((t) => t.auction_id))]),
      // Pakken er sendt retur (ikke afhentet): frigives aldrig automatisk
      // (handel_auto_frigiv, 20261016030000) - ingen påmindelse.
      admin
        .from("forsendelser")
        .select("trade_id")
        .in("trade_id", ids)
        .eq("type", "udgaaende")
        .not("returneret_kl", "is", null),
      // Filip 11. okt. 2026: kun med BidHamrs fragtlabel og en
      // leveringsmelding frigives der automatisk efter 14 dage.
      admin
        .from("forsendelser")
        .select("trade_id")
        .in("trade_id", ids)
        .eq("type", "udgaaende")
        .not("status", "in", "(annulleret,fejlet)")
        .not("leveret_kl", "is", null),
    ]);
    const autoMulig = new Set((leveret ?? []).map((f) => f.trade_id as string));
    const medSag = new Set([
      ...(sager ?? []).map((s) => s.trade_id as string),
      ...(retur ?? []).map((f) => f.trade_id as string),
    ]);
    const betalt = new Set(
      (betalinger ?? [])
        .filter(
          (b) =>
            !indsigelseBlokerer({
              indsigelse_kl: b.indsigelse_kl as string | null,
              indsigelse_status: b.indsigelse_status as string | null,
            }),
        )
        .map((b) => b.trade_id as string),
    );
    const titler = new Map((auktioner ?? []).map((a) => [a.id as string, a.titel as string]));

    let antal = 0;
    for (const t of liste) {
      if (medSag.has(t.id) || !betalt.has(t.id)) continue;
      const sendt = Date.parse(t.sendt_kl);
      if (Number.isNaN(sendt)) continue;
      const titel = titler.get(t.auction_id) ?? "din vare";
      const r = await send(t.buyer_id, "pakke_sendt", {
        titel: "Har du modtaget din vare?",
        tekst: autoMulig.has(t.id)
          ? `Har du modtaget "${titel}"? Markér den som modtaget, eller meld den bortkommet – ellers udbetales pengene til sælgeren ${datoTekst(sendt + SAG_AUTO_FRIGIV_EFTER_DAGE * DAG)}.`
          : `Har du modtaget "${titel}"? Markér den som modtaget, eller meld den bortkommet, så vi kan hjælpe dig.`,
        link: `/mine-handler/${t.id}`,
        data: { trade_id: t.id },
        noegle: `paamind_modtaget:${t.id}`,
      }, { springOverVedClaimFejl: true });
      if (!r.dublet && (r.klokke || r.mail || r.push)) antal++;
    }
    return antal;
  } catch (err) {
    console.error("Påmindelse om modtagelse fejlede:", err);
    return 0;
  }
}
