import "server-only";

// Server-only: fragtfirmaets leveringsmelding starter 48-timers uret
// (ROADMAP fase 2 "Auto-frigivelse 48 timer efter afhentning, hvis ingen
// sag"; ROADMAP-BESLUTNINGER afsnit 1: "Uret starter, når sporingen viser, at
// køberen har hentet pakken").
//
// Når fragtfirmaet melder pakken leveret/afhentet (forsendelser.leveret_kl,
// og meldingen må frigive penge - leveret_frigiver), flytter databasen
// handlen til 'modtaget' præcis som købers "Jeg har modtaget pakken"
// (handel_fragt_leveret_start, 20261030010000). Køberen har derefter 48 timer
// til at oprette en sag; ellers frigiver handel_auto_frigiv pengene (ingen
// bedømmelse). Ingen penge flyttes her.
//
// Uret regnes fra REGISTRERINGEN hos BidHamr (received_at = now() i
// databasen), ikke fra fragtfirmaets hændelsestidspunkt: DAO's sporing kan
// være op til 24 timer forsinket, og køberen skal altid have fulde 48 timer
// efter beskeden.
//
// Beskeder: køberen ("Du har 48 timer til at melde en fejl") og sælgeren
// (hvornår pengene frigives). Idempotent: faste nøgler, og
// trades.fragt_ur_besked_kl sættes bagefter, så cron sender beskeden igen,
// hvis serveren døde imellem. Kaster aldrig.
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import { SAG_FRIST_TIMER_EFTER_MODTAGET } from "@/lib/sager";

const TIME_MS = 60 * 60 * 1000;

type Admin = ReturnType<typeof createAdminClient>;

// Fx "lørdag 24. oktober kl. 14.30" (dansk tid).
export function fragtUrFristTekst(iso: string): string {
  const d = new Date(iso);
  const dag = d.toLocaleDateString("da-DK", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Copenhagen",
  });
  const tid = d.toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Copenhagen" });
  return `${dag} kl. ${tid}`;
}

// Fristen for at oprette en sag (og tidspunktet for den automatiske
// frigivelse): received_at + 48 timer.
export function fragtUrFrist(receivedAt: string): string | null {
  const ms = Date.parse(receivedAt);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + SAG_FRIST_TIMER_EFTER_MODTAGET * TIME_MS).toISOString();
}

export function fragtUrKoeberTekst(titel: string, fristIso: string): string {
  return `Fragtfirmaet melder, at "${titel}" er leveret. Tjek varen. Er der noget galt, har du 48 timer – til ${fragtUrFristTekst(fristIso)} – til at melde en fejl på handelssiden. Ellers frigives pengene automatisk til sælgeren. Er alt i orden, kan du godkende varen med det samme.`;
}

export function fragtUrSaelgerTekst(titel: string, fristIso: string): string {
  return `Fragtfirmaet melder, at "${titel}" er leveret til køberen. Du får pengene, når køberen har godkendt varen – eller automatisk ${fragtUrFristTekst(fristIso)}, hvis køberen ikke har meldt en fejl inden da.`;
}

type HandelRaekke = {
  id: string;
  auction_id: string;
  buyer_id: string;
  seller_id: string;
  status: string;
  received_at: string | null;
  modtaget_kilde: string | null;
  fragt_ur_besked_kl: string | null;
};

// Beskeden til køber og sælger om, at uret er startet. Sendes kun, mens
// handlen stadig står i 'modtaget' (er den allerede godkendt, frigivet eller
// har fået en sag, er beskeden forældet - så markeres den bare som sendt).
async function sendBesked(admin: Admin, t: HandelRaekke, titler?: Map<string, string>): Promise<boolean> {
  if (t.modtaget_kilde !== "fragt" || t.fragt_ur_besked_kl) return false;
  let sendt = false;
  const frist = t.received_at ? fragtUrFrist(t.received_at) : null;
  if (t.status === "modtaget" && frist) {
    let titel = titler?.get(t.auction_id);
    if (!titel) {
      const { data: a } = await admin.from("auctions").select("titel").eq("id", t.auction_id).maybeSingle<{ titel: string | null }>();
      titel = a?.titel ?? "din vare";
    }
    const link = `/mine-handler/${t.id}`;
    await send(t.buyer_id, "pakke_leveret", {
      titel: "Pakken er kommet frem",
      tekst: fragtUrKoeberTekst(titel, frist),
      link,
      data: { trade_id: t.id },
      noegle: `fragt_ur:${t.id}`,
    });
    // Samme nøgle som ved købers "modtaget" (handelstrin.ts) - de to
    // udelukker hinanden, så sælgeren får præcis én besked.
    await send(t.seller_id, "pakke_leveret", {
      titel: "Pakken er kommet frem",
      tekst: fragtUrSaelgerTekst(titel, frist),
      link,
      data: { trade_id: t.id },
      noegle: `pakke_leveret:${t.id}`,
    });
    sendt = true;
  }
  const { error } = await admin.rpc("handel_fragt_ur_besked_sendt", { p_trade: t.id });
  if (error) await logDriftFejl({ kilde: "cron", hvor: "Fragt: besked om 48-timers uret", fejl: error });
  return sendt;
}

const KOLONNER = "id, auction_id, buyer_id, seller_id, status, received_at, modtaget_kilde, fragt_ur_besked_kl";

// Starter uret for én handel (efter en ny leveringsmelding) eller - uden
// tradeId - for alle handler, hvor det mangler (cron-reserven, fx når
// sælgeren markerede pakken sendt EFTER leveringsmeldingen), og sender
// beskeder, der mangler. Returnerer antal handler, hvor uret blev startet nu.
// Kaster aldrig.
export async function startUrFraFragt(tradeId?: string): Promise<number> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("handel_fragt_leveret_start", { p_trade: tradeId ?? null });
    // Før migrationen 20261030010000: intet at gøre (ingen alarm hver kørsel).
    if (error && (error.code === "PGRST202" || error.code === "42883")) return 0;
    if (error) {
      await logDriftFejl({ kilde: "cron", hvor: "Fragt: start 48-timers uret", fejl: error });
      return 0;
    }
    const startet = (Array.isArray(data) ? data : []) as { trade_id: string }[];

    // Beskeder: de netop startede + dem, der mangler fra tidligere.
    let q = admin
      .from("trades")
      .select(KOLONNER)
      .eq("modtaget_kilde", "fragt")
      .is("fragt_ur_besked_kl", null)
      .order("received_at", { ascending: true })
      .limit(100);
    if (tradeId) q = q.eq("id", tradeId);
    const { data: mangler, error: mFejl } = await q;
    if (mFejl) {
      await logDriftFejl({ kilde: "cron", hvor: "Fragt: beskeder om 48-timers uret", fejl: mFejl });
      return startet.length;
    }
    const liste = (mangler ?? []) as HandelRaekke[];
    if (liste.length > 0) {
      const { data: auktioner } = await admin
        .from("auctions")
        .select("id, titel")
        .in("id", [...new Set(liste.map((t) => t.auction_id))]);
      const titler = new Map((auktioner ?? []).map((a) => [a.id as string, (a.titel as string) ?? "din vare"]));
      for (const t of liste) await sendBesked(admin, t, titler);
    }
    return startet.length;
  } catch (err) {
    await logDriftFejl({ kilde: "cron", hvor: "Fragt: start 48-timers uret", fejl: err });
    return 0;
  }
}

// Til fragtens handelseffekter: blev handlen startet af fragtfirmaet (så
// sendes "Pakken er kommet frem" herfra i stedet for den gamle besked)?
export async function urStartetAfFragt(tradeId: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("trades")
    .select("modtaget_kilde")
    .eq("id", tradeId)
    .maybeSingle<{ modtaget_kilde: string | null }>();
  return data?.modtaget_kilde === "fragt";
}
