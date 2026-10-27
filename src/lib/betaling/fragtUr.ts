import "server-only";

// Server-only: fragtfirmaets leveringsmelding starter uret for at melde et
// problem (ROADMAP-BESLUTNINGER afsnit 1 og 4 - 72 timer efter levering, Filip
// 27. okt. 2026; før 48).
//
// Når fragtfirmaet melder pakken leveret/afhentet (forsendelser.leveret_kl,
// og meldingen må frigive penge - leveret_frigiver), flytter databasen
// handlen til 'modtaget' præcis som købers "Jeg har modtaget pakken"
// (handel_fragt_leveret_start, 20261030010000). Køberen har derefter til
// trades.problem_frist_kl (72 t; 48 t for handler modtaget før 20261102210000)
// til at melde et problem; ellers frigiver handel_auto_frigiv pengene (ingen
// bedømmelse). Ingen penge flyttes her.
//
// Uret regnes fra REGISTRERINGEN hos BidHamr (received_at = now() i
// databasen), ikke fra fragtfirmaets hændelsestidspunkt: DAO's sporing kan
// være op til 24 timer forsinket, og køberen skal altid have hele fristen
// efter beskeden.
//
// Beskeder: køberen ("Pakken er leveret - gem pakken og labelen", tid tilbage
// og et link direkte til trin 1 i "Meld et problem") og sælgeren
// (hvornår pengene frigives). Idempotent: faste nøgler, og
// trades.fragt_ur_besked_kl sættes bagefter, så cron sender beskeden igen,
// hvis serveren døde imellem. Kaster aldrig.
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import { sagProblemFristKl } from "@/lib/sager";
import { meldProblemLink, tidTilbageTekst } from "@/lib/sagerServer";

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

// Fristen for at melde et problem (og tidspunktet for den automatiske
// frigivelse): trades.problem_frist_kl - ellers received_at + 48 timer.
export function fragtUrFrist(receivedAt: string, problemFristKl?: string | null): string | null {
  return sagProblemFristKl(receivedAt, problemFristKl);
}

// Regel 5 (Filip, 27. okt. 2026): fristen som tid tilbage, "Gem pakken og
// labelen" og et link direkte til trin 1 (se fragtUrKoeberLink).
export function fragtUrKoeberTekst(titel: string, fristIso: string, nu: number = Date.now()): string {
  return `Tjek "${titel}". Du har ${tidTilbageTekst(fristIso, nu)} til at melde et problem – senest ${fragtUrFristTekst(fristIso)}. Gem pakken og labelen indtil da. Er alt i orden, så godkend varen. Så får sælgeren sine penge.`;
}

export function fragtUrKoeberLink(tradeId: string): string {
  return meldProblemLink(tradeId);
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
  problem_frist_kl?: string | null;
};

// Beskeden til køber og sælger om, at uret er startet. Sendes kun, mens
// handlen stadig står i 'modtaget' (er den allerede godkendt, frigivet eller
// har fået en sag, er beskeden forældet - så markeres den bare som sendt).
async function sendBesked(admin: Admin, t: HandelRaekke, titler?: Map<string, string>): Promise<boolean> {
  if (t.modtaget_kilde !== "fragt" || t.fragt_ur_besked_kl) return false;
  let sendt = false;
  const frist = t.received_at ? fragtUrFrist(t.received_at, t.problem_frist_kl) : null;
  if (t.status === "modtaget" && frist) {
    let titel = titler?.get(t.auction_id);
    if (!titel) {
      const { data: a } = await admin.from("auctions").select("titel").eq("id", t.auction_id).maybeSingle<{ titel: string | null }>();
      titel = a?.titel ?? "din vare";
    }
    const link = `/mine-handler/${t.id}`;
    await send(t.buyer_id, "pakke_leveret", {
      titel: "Pakken er leveret – tjek varen",
      tekst: fragtUrKoeberTekst(titel, frist),
      // Direkte til trin 1 i "Meld et problem" (handelssiden åbner den).
      link: fragtUrKoeberLink(t.id),
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
// problem_frist_kl findes efter 20261102210000.
const KOLONNER_MED_FRIST = `${KOLONNER}, problem_frist_kl`;

// Starter uret for én handel (efter en ny leveringsmelding) eller - uden
// tradeId - for alle handler, hvor det mangler (cron-reserven, fx når
// sælgeren markerede pakken sendt EFTER leveringsmeldingen), og sender
// beskeder, der mangler. Returnerer, om databasen svarede (ok), og antal
// handler, hvor uret blev startet nu. ok = false: databasen fejlede, så ingen
// ved, om uret er startet - fragtens handelseffekter sender da IKKE den gamle
// besked (så køberen ikke får to), men lader cron prøve igen. Kaster aldrig.
export type UrStart = { ok: boolean; startet: number };

export async function startUrFraFragt(tradeId?: string): Promise<UrStart> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("handel_fragt_leveret_start", { p_trade: tradeId ?? null });
    // Før migrationen 20261030010000: intet at gøre (ingen alarm hver kørsel).
    if (error && (error.code === "PGRST202" || error.code === "42883")) return { ok: true, startet: 0 };
    if (error) {
      await logDriftFejl({ kilde: "cron", hvor: "Fragt: start 48-timers uret", fejl: error });
      return { ok: false, startet: 0 };
    }
    const startet = (Array.isArray(data) ? data : []) as { trade_id: string }[];

    // Beskeder: de netop startede + dem, der mangler fra tidligere.
    const hent = (k: string) => {
      let q = admin
        .from("trades")
        .select(k)
        .eq("modtaget_kilde", "fragt")
        .is("fragt_ur_besked_kl", null)
        .order("received_at", { ascending: true })
        .limit(100);
      if (tradeId) q = q.eq("id", tradeId);
      return q;
    };
    let svar = await hent(KOLONNER_MED_FRIST);
    if (svar.error?.code === "42703") svar = await hent(KOLONNER);
    const { data: mangler, error: mFejl } = svar;
    if (mFejl) {
      await logDriftFejl({ kilde: "cron", hvor: "Fragt: beskeder om 48-timers uret", fejl: mFejl });
      return { ok: true, startet: startet.length };
    }
    const liste = (mangler ?? []) as unknown as HandelRaekke[];
    if (liste.length > 0) {
      const { data: auktioner } = await admin
        .from("auctions")
        .select("id, titel")
        .in("id", [...new Set(liste.map((t) => t.auction_id))]);
      const titler = new Map((auktioner ?? []).map((a) => [a.id as string, (a.titel as string) ?? "din vare"]));
      for (const t of liste) await sendBesked(admin, t, titler);
    }
    return { ok: true, startet: startet.length };
  } catch (err) {
    await logDriftFejl({ kilde: "cron", hvor: "Fragt: start 48-timers uret", fejl: err });
    return { ok: false, startet: 0 };
  }
}

// Til fragtens handelseffekter: blev handlen startet af fragtfirmaet (så
// sendes "Pakken er kommet frem" herfra i stedet for den gamle besked)?
// null = databasen svarede ikke (ukendt - send ingen besked nu).
export async function urStartetAfFragt(tradeId: string): Promise<boolean | null> {
  const { data, error } = await createAdminClient()
    .from("trades")
    .select("modtaget_kilde")
    .eq("id", tradeId)
    .maybeSingle<{ modtaget_kilde: string | null }>();
  // Før migrationen 20261030010000 findes kolonnen ikke: så har fragten
  // aldrig startet uret, og den gamle besked skal sendes.
  if (error && (error.code === "42703" || error.code === "PGRST204")) return false;
  if (error) {
    await logDriftFejl({ kilde: "cron", hvor: "Fragt: læs om 48-timers uret er startet", fejl: error });
    return null;
  }
  if (!data) return null;
  return data.modtaget_kilde === "fragt";
}
