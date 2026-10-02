import "server-only";

// Cron-trin for notifikationer om begivenheder, der i dag sker direkte fra
// browseren (likes, beskeder) eller uden en server-hændelse (auktion slutter
// snart, ny auktion fra fulgt sælger, advarsler fra flere admin-steder).
//
// Hver begivenhed har en fast nøgle. Allerede sendte nøgler sorteres fra med
// ét opslag, og send() claimer nøglen atomisk - så overlappende kørsler og
// gentagelser aldrig giver dobbelte beskeder.
import { createAdminClient } from "@/lib/supabase/admin";
import { send, type NotifikationInput } from "@/lib/notifikationer/send";
import type { NotifikationType } from "@/lib/notifikationer/typer";

type Admin = ReturnType<typeof createAdminClient>;

type Opgave = {
  brugerId: string;
  type: NotifikationType;
  input: NotifikationInput & { noegle: string };
};

const TIME = 60 * 60 * 1000;
const MAKS = 500;

async function sendNye(admin: Admin, opgaver: Opgave[]): Promise<number> {
  if (opgaver.length === 0) return 0;
  const sendt = new Set<string>();
  for (let i = 0; i < opgaver.length; i += 200) {
    const noegler = opgaver.slice(i, i + 200).map((o) => o.input.noegle);
    const { data, error } = await admin
      .from("notifikation_afsendelser")
      .select("noegle")
      .in("noegle", noegler);
    if (error) {
      console.error("Notifikationer: opslag af sendte nøgler fejlede:", error.message);
      return 0;
    }
    for (const r of data ?? []) sendt.add(r.noegle as string);
  }
  let antal = 0;
  for (const o of opgaver) {
    if (sendt.has(o.input.noegle)) continue;
    const r = await send(o.brugerId, o.type, o.input);
    if (!r.dublet) antal++;
  }
  return antal;
}

async function titler(admin: Admin, ids: string[]) {
  if (ids.length === 0) return new Map<string, { titel: string; saelger: string }>();
  const { data } = await admin
    .from("auctions")
    .select("id, titel, bruger_id")
    .in("id", [...new Set(ids)]);
  return new Map(
    (data ?? []).map((a) => [
      a.id as string,
      { titel: a.titel as string, saelger: a.bruger_id as string },
    ]),
  );
}

// Advarsler gives fra flere steder (admin-brugerside, ubetalt-sag,
// betalingssag). Alle opfanges her ud fra advarsler-tabellen.
export async function notificerAdvarsler(): Promise<number> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("advarsler")
    .select("id, bruger_id")
    .gte("oprettet_kl", new Date(Date.now() - 48 * TIME).toISOString())
    .limit(MAKS);
  return sendNye(
    admin,
    (data ?? []).map((a) => ({
      brugerId: a.bruger_id as string,
      type: "advarsel" as const,
      input: {
        titel: "Du har fået en advarsel",
        // Årsagen er medarbejderens interne begrundelse og vises ikke her.
        tekst: "Du har fået en advarsel fra BidHamr. Tre advarsler betyder, at din profil lukkes. Kontakt support@bidhamr.dk, hvis du har spørgsmål.",
        link: "/konto",
        data: { advarsel_id: a.id },
        noegle: `advarsel:${a.id}`,
      },
    })),
  );
}

async function likes(admin: Admin): Promise<number> {
  const { data } = await admin
    .from("favorites")
    .select("user_id, auction_id")
    .gte("created_at", new Date(Date.now() - 24 * TIME).toISOString())
    .limit(MAKS);
  const a = await titler(admin, (data ?? []).map((f) => f.auction_id as string));
  const opgaver: Opgave[] = [];
  for (const f of data ?? []) {
    const auk = a.get(f.auction_id as string);
    if (!auk || auk.saelger === f.user_id) continue;
    opgaver.push({
      brugerId: auk.saelger,
      type: "like",
      input: {
        titel: "Nogen har liket din auktion",
        tekst: `"${auk.titel}" er gemt som favorit.`,
        link: `/auktion/${f.auction_id}`,
        data: { auction_id: f.auction_id },
        noegle: `like:${f.auction_id}:${f.user_id}`,
      },
    });
  }
  return sendNye(admin, opgaver);
}

async function slutterSnart(admin: Admin): Promise<number> {
  const nu = Date.now();
  const { data: auktioner } = await admin
    .from("auctions")
    .select("id, titel, bruger_id")
    .eq("status", "aktiv")
    .eq("skjult", false)
    .gt("slutter_kl", new Date(nu).toISOString())
    .lte("slutter_kl", new Date(nu + TIME).toISOString())
    .limit(MAKS);
  if (!auktioner || auktioner.length === 0) return 0;
  const { data: fav } = await admin
    .from("favorites")
    .select("user_id, auction_id")
    .in("auction_id", auktioner.map((a) => a.id as string))
    .limit(5000);
  const map = new Map(auktioner.map((a) => [a.id as string, a]));
  const opgaver: Opgave[] = [];
  for (const f of fav ?? []) {
    const a = map.get(f.auction_id as string);
    if (!a || a.bruger_id === f.user_id) continue;
    opgaver.push({
      brugerId: f.user_id as string,
      type: "fulgt_slutter_snart",
      input: {
        titel: "En favorit slutter snart",
        tekst: `"${a.titel}" slutter om under en time.`,
        link: `/auktion/${a.id}`,
        data: { auction_id: a.id },
        noegle: `slutter:${a.id}:${f.user_id}`,
      },
    });
  }
  return sendNye(admin, opgaver);
}

async function nyAuktionFraFulgt(admin: Admin): Promise<number> {
  const { data: auktioner } = await admin
    .from("auctions")
    .select("id, titel, bruger_id")
    .eq("status", "aktiv")
    .eq("skjult", false)
    .gte("oprettet", new Date(Date.now() - 24 * TIME).toISOString())
    .limit(MAKS);
  if (!auktioner || auktioner.length === 0) return 0;
  const { data: foelgere } = await admin
    .from("seller_follows")
    .select("follower_id, seller_id")
    .in("seller_id", [...new Set(auktioner.map((a) => a.bruger_id as string))])
    .limit(5000);
  const opgaver: Opgave[] = [];
  for (const a of auktioner) {
    for (const f of foelgere ?? []) {
      if (f.seller_id !== a.bruger_id) continue;
      opgaver.push({
        brugerId: f.follower_id as string,
        type: "ny_auktion_fulgt_saelger",
        input: {
          titel: "Ny auktion fra en sælger, du følger",
          tekst: `"${a.titel}" er sat til salg.`,
          link: `/auktion/${a.id}`,
          data: { auction_id: a.id },
          noegle: `ny_auktion:${a.id}:${f.follower_id}`,
        },
      });
    }
  }
  return sendNye(admin, opgaver);
}

async function beskeder(admin: Admin): Promise<number> {
  const { data: besk } = await admin
    .from("messages")
    .select("id, trade_id, sender_id, content")
    .gte("created_at", new Date(Date.now() - 24 * TIME).toISOString())
    .order("created_at", { ascending: true })
    .limit(MAKS);
  if (!besk || besk.length === 0) return 0;
  const { data: handler } = await admin
    .from("trades")
    .select("id, buyer_id, seller_id, auction_id")
    .in("id", [...new Set(besk.map((b) => b.trade_id as string))]);
  const hmap = new Map((handler ?? []).map((h) => [h.id as string, h]));
  const a = await titler(admin, (handler ?? []).map((h) => h.auction_id as string));
  const opgaver: Opgave[] = [];
  for (const b of besk) {
    const h = hmap.get(b.trade_id as string);
    if (!h) continue;
    const titel = a.get(h.auction_id as string)?.titel ?? "din handel";
    for (const modtager of [h.buyer_id as string, h.seller_id as string]) {
      if (modtager === b.sender_id) continue;
      opgaver.push({
        brugerId: modtager,
        type: "ny_besked",
        input: {
          titel: "Ny besked",
          tekst: `Ny besked om "${titel}": ${String(b.content ?? "").slice(0, 120)}`,
          link: `/mine-handler/${h.id}`,
          data: { trade_id: h.id, message_id: b.id },
          noegle: `besked:${b.id}:${modtager}`,
        },
      });
    }
  }
  return sendNye(admin, opgaver);
}

// Kører fra betalings-cron'en (hvert 5. minut). Kaster aldrig.
export async function koerNotifikationsCron() {
  const admin = createAdminClient();
  const resultat = { advarsler: 0, likes: 0, slutterSnart: 0, nyAuktion: 0, beskeder: 0 };
  const trin: [keyof typeof resultat, () => Promise<number>][] = [
    ["advarsler", notificerAdvarsler],
    ["likes", () => likes(admin)],
    ["slutterSnart", () => slutterSnart(admin)],
    ["nyAuktion", () => nyAuktionFraFulgt(admin)],
    ["beskeder", () => beskeder(admin)],
  ];
  for (const [navn, fn] of trin) {
    try {
      resultat[navn] = await fn();
    } catch (err) {
      console.error(`Notifikations-cron (${navn}) fejlede:`, err);
    }
  }
  return resultat;
}
