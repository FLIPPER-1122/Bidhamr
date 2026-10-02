import "server-only";

// Cron-trin for notifikationer om begivenheder, der i dag sker direkte fra
// browseren/appen (likes, beskeder, bud fra appen) eller uden en
// server-hændelse (auktion slutter snart, ny auktion fra fulgt sælger,
// advarsler fra flere admin-steder).
//
// Hver begivenhed har en fast nøgle. Allerede sendte nøgler sorteres fra med
// ét opslag, og send() claimer nøglen atomisk - så overlappende kørsler og
// gentagelser aldrig giver dobbelte beskeder.
//
// Der sendes aldrig for begivenheder før notifikation_system.start_kl (sat,
// da notifikationssystemet blev slået til), og højst 24 timer tilbage.
// Mangler start_kl (migrationen er ikke kørt), springes de trin over.
import { createAdminClient } from "@/lib/supabase/admin";
import { send, type NotifikationInput } from "@/lib/notifikationer/send";
import type { NotifikationType } from "@/lib/notifikationer/typer";
import {
  budPaaEgenNoegle,
  markerBudBehandlet,
  notificerBud,
} from "@/lib/notifikationer/bud";

type Admin = ReturnType<typeof createAdminClient>;

type Opgave = {
  brugerId: string;
  type: NotifikationType;
  input: NotifikationInput & { noegle: string };
};

const TIME = 60 * 60 * 1000;
const MAKS = 500;

// Hvornår notifikationssystemet blev slået til. null = ukendt (tabellen
// mangler eller kan ikke læses) - så sender cron'en intet for gamle
// begivenheder.
async function hentStart(admin: Admin): Promise<Date | null> {
  const { data, error } = await admin
    .from("notifikation_system")
    .select("start_kl")
    .eq("id", 1)
    .maybeSingle<{ start_kl: string }>();
  if (error || !data) {
    console.error("Notifikationer: start_kl mangler:", error?.message ?? "ingen række");
    return null;
  }
  return new Date(data.start_kl);
}

// Det seneste af "timer tilbage" og systemstart.
function fraTid(start: Date, timer: number): string {
  return new Date(Math.max(start.getTime(), Date.now() - timer * TIME)).toISOString();
}

// Hvilke af nøglerne er allerede sendt? null ved fejl.
async function sendteNoegler(admin: Admin, noegler: string[]): Promise<Set<string> | null> {
  const sendt = new Set<string>();
  for (let i = 0; i < noegler.length; i += 200) {
    const { data, error } = await admin
      .from("notifikation_afsendelser")
      .select("noegle")
      .in("noegle", noegler.slice(i, i + 200));
    if (error) {
      console.error("Notifikationer: opslag af sendte nøgler fejlede:", error.message);
      return null;
    }
    for (const r of data ?? []) sendt.add(r.noegle as string);
  }
  return sendt;
}

async function sendNye(admin: Admin, opgaver: Opgave[]): Promise<number> {
  if (opgaver.length === 0) return 0;
  const sendt = await sendteNoegler(admin, opgaver.map((o) => o.input.noegle));
  if (!sendt) return 0;
  let antal = 0;
  for (const o of opgaver) {
    if (sendt.has(o.input.noegle)) continue;
    // Valgfrie typer springes over, hvis nøglen ikke kan claimes - ellers
    // sendes samme hændelse ved hver kørsel. Påkrævede (advarsel) sendes stadig.
    const r = await send(o.brugerId, o.type, o.input, { springOverVedClaimFejl: true });
    if (!r.dublet && !r.sprunget) antal++;
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
// Kaster aldrig (kaldes også fra after() i admin-actions).
export async function notificerAdvarsler(): Promise<number> {
  try {
    const admin = createAdminClient();
    const start = await hentStart(admin);
    if (!start) return 0;
    return await advarsler(admin, start);
  } catch (err) {
    console.error("Notifikationer: advarsler fejlede:", err);
    return 0;
  }
}

// Teksten til brugeren. Kun begrundelse_bruger - ALDRIG aarsag (intern note).
// Mailen escaper teksten (notifikationMail), klokke/push er ren tekst.
export function advarselTekst(begrundelseBruger: string | null): string {
  const slut =
    "Efter 3 advarsler lukkes din profil permanent. Kontakt support@bidhamr.dk, hvis du har spørgsmål.";
  const b = (begrundelseBruger ?? "").trim();
  if (!b) return `Du har fået en advarsel fra BidHamr.\n${slut}`;
  const punktum = /[.!?]$/.test(b) ? "" : ".";
  return `Du har fået en advarsel fra BidHamr. Begrundelse: ${b}${punktum}\n${slut}`;
}

async function advarsler(admin: Admin, start: Date): Promise<number> {
  // Vælg kun de felter, der må vises for brugeren (+ id og modtager).
  const { data, error } = await admin
    .from("advarsler")
    .select("id, bruger_id, begrundelse_bruger")
    .gte("oprettet_kl", fraTid(start, 48))
    .order("oprettet_kl", { ascending: false })
    .limit(MAKS);
  if (error) {
    console.error("Notifikationer: advarsler kunne ikke hentes:", error.message);
    return 0;
  }
  return sendNye(
    admin,
    (data ?? []).map((a) => ({
      brugerId: a.bruger_id as string,
      type: "advarsel" as const,
      input: {
        titel: "Du har fået en advarsel",
        tekst: advarselTekst(a.begrundelse_bruger as string | null),
        link: "/konto#advarsler",
        data: { advarsel_id: a.id },
        noegle: `advarsel:${a.id}`,
      },
    })),
  );
}

// Hvem der likede, står kun i nøglen (notifikation_afsendelser, kun
// service-role) - aldrig i teksten eller data, som sælgeren kan læse.
async function likes(admin: Admin, start: Date): Promise<number> {
  // Nyeste først, så nye likes ikke sultes, hvis der er mange.
  const { data } = await admin
    .from("favorites")
    .select("user_id, auction_id")
    .gte("created_at", fraTid(start, 24))
    .order("created_at", { ascending: false })
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
        tekst: `En bruger har gemt "${auk.titel}" som favorit.`,
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
        tekst: `"${a.titel}" slutter om under en time. Byd nu, hvis du vil være med.`,
        link: `/auktion/${a.id}`,
        data: { auction_id: a.id },
        noegle: `slutter:${a.id}:${f.user_id}`,
      },
    });
  }
  return sendNye(admin, opgaver);
}

async function nyAuktionFraFulgt(admin: Admin, start: Date): Promise<number> {
  const { data: auktioner } = await admin
    .from("auctions")
    .select("id, titel, bruger_id")
    .eq("status", "aktiv")
    .eq("skjult", false)
    .gte("oprettet", fraTid(start, 24))
    .order("oprettet", { ascending: false })
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
          tekst: `"${a.titel}" er lige sat på auktion.`,
          link: `/auktion/${a.id}`,
          data: { auction_id: a.id },
          noegle: `ny_auktion:${a.id}:${f.follower_id}`,
        },
      });
    }
  }
  return sendNye(admin, opgaver);
}

// Bud, der ikke kom gennem afgivBud (appen indsætter direkte via RLS), eller
// hvor afsendelsen fejlede. Samme nøgler og logik som afgivBud
// (lib/notifikationer/bud.ts), så intet sendes dobbelt. bud_paa_egen-nøglen
// sendes sidst og markerer et bud som færdigbehandlet.
async function bud(admin: Admin, start: Date): Promise<number> {
  // Nyeste først, så nye bud ikke sultes.
  const { data: nye } = await admin
    .from("bids")
    .select("id, auktion_id, bruger_id, beløb")
    .gte("oprettet", fraTid(start, 24))
    .order("oprettet", { ascending: false })
    .limit(MAKS)
    .overrideTypes<
      { id: string; auktion_id: string; bruger_id: string; beløb: number | string }[],
      { merge: false }
    >();
  if (!nye || nye.length === 0) return 0;
  const sendt = await sendteNoegler(admin, nye.map((b) => budPaaEgenNoegle(b.id as string)));
  if (!sendt) return 0;
  const mangler = nye.filter((b) => !sendt.has(budPaaEgenNoegle(b.id as string)));
  if (mangler.length === 0) return 0;

  const { data: auk } = await admin
    .from("auctions")
    .select("id, titel, bruger_id, status, slutter_kl")
    .in("id", [...new Set(mangler.map((b) => b.auktion_id as string))]);
  const amap = new Map((auk ?? []).map((a) => [a.id as string, a]));
  const nu = Date.now();

  let antal = 0;
  // Ældste først inden for udvalget, så rækkefølgen giver mening for modtageren.
  for (const b of [...mangler].reverse()) {
    const a = amap.get(b.auktion_id as string);
    if (!a) continue;
    // Når auktionen er slut, er "byd igen" misvisende; vundet/solgt dækker det.
    // Buddet markeres som behandlet uden afsendelse, så det ikke hentes igen
    // ved hver kørsel. Samme for sælgerens eget bud (notificerBud sender intet
    // og sætter derfor ingen markør).
    if (
      a.status !== "aktiv" ||
      !a.slutter_kl ||
      new Date(a.slutter_kl as string).getTime() <= nu ||
      a.bruger_id === b.bruger_id
    ) {
      await markerBudBehandlet(admin, b.id, a.bruger_id as string);
      continue;
    }
    try {
      await notificerBud(
        admin,
        {
          id: b.id,
          auktion_id: b.auktion_id,
          bruger_id: b.bruger_id,
          beloeb: Number(b.beløb),
        },
        { titel: a.titel as string, bruger_id: a.bruger_id as string },
        { springOverVedClaimFejl: true },
      );
      antal++;
    } catch (err) {
      console.error("Notifikationer: bud", b.id, "fejlede:", err);
    }
  }
  return antal;
}

// Chatbeskeder samles pr. handel pr. modtager pr. kørsel til én notifikation.
// Hver besked har stadig sin egen nøgle (besked:<id>:<modtager>); de claimes
// samlet, før der sendes, så en besked aldrig tælles med to gange.
async function beskeder(admin: Admin, start: Date): Promise<number> {
  // Nyeste først, så nye beskeder ikke sultes bag gamle.
  const { data: besk } = await admin
    .from("messages")
    .select("id, trade_id, sender_id, content, created_at")
    .gte("created_at", fraTid(start, 24))
    .order("created_at", { ascending: false })
    .limit(MAKS);
  if (!besk || besk.length === 0) return 0;
  const { data: handler } = await admin
    .from("trades")
    .select("id, buyer_id, seller_id, auction_id")
    .in("id", [...new Set(besk.map((b) => b.trade_id as string))]);
  const hmap = new Map((handler ?? []).map((h) => [h.id as string, h]));

  type Besked = (typeof besk)[number];
  // (handel, modtager) -> beskeder, nyeste først.
  type Gruppe = { tradeId: string; modtager: string; auktionId: string; beskeder: Besked[] };
  const grupper = new Map<string, Gruppe>();
  for (const b of besk) {
    const h = hmap.get(b.trade_id as string);
    if (!h) continue;
    for (const modtager of [h.buyer_id as string, h.seller_id as string]) {
      if (!modtager || modtager === b.sender_id) continue;
      const k = `${h.id}:${modtager}`;
      let g = grupper.get(k);
      if (!g) {
        g = { tradeId: h.id as string, modtager, auktionId: h.auction_id as string, beskeder: [] };
        grupper.set(k, g);
      }
      g.beskeder.push(b);
    }
  }
  if (grupper.size === 0) return 0;

  const noegle = (beskedId: string, modtager: string) => `besked:${beskedId}:${modtager}`;
  const alle = [...grupper.values()].flatMap((g) =>
    g.beskeder.map((b) => noegle(b.id as string, g.modtager)),
  );
  const sendt = await sendteNoegler(admin, alle);
  if (!sendt) return 0;
  const a = await titler(admin, [...grupper.values()].map((g) => g.auktionId));

  let antal = 0;
  for (const g of grupper.values()) {
    const nyeIGruppe = g.beskeder.filter((b) => !sendt.has(noegle(b.id as string, g.modtager)));
    if (nyeIGruppe.length === 0) continue;
    // Claim alle nøgler atomisk; kun de beskeder, denne kørsel fik, tælles.
    // (on conflict do nothing + returning giver kun de nyindsatte rækker.)
    const { data: claimed, error } = await admin
      .from("notifikation_afsendelser")
      .upsert(
        nyeIGruppe.map((b) => ({
          noegle: noegle(b.id as string, g.modtager),
          bruger_id: g.modtager,
          type: "ny_besked",
        })),
        { onConflict: "noegle", ignoreDuplicates: true },
      )
      .select("noegle");
    if (error) {
      // Valgfri type: hellere springe over end risikere dobbelte beskeder.
      console.error("Notifikationer: claim af beskeder fejlede:", error.message);
      continue;
    }
    const fik = new Set((claimed ?? []).map((r) => r.noegle as string));
    const mine = nyeIGruppe.filter((b) => fik.has(noegle(b.id as string, g.modtager)));
    if (mine.length === 0) continue;

    const titel = a.get(g.auktionId)?.titel ?? "din handel";
    const link = `/mine-handler/${g.tradeId}`;
    const data = { trade_id: g.tradeId };
    const input: NotifikationInput =
      mine.length === 1
        ? {
            titel: "Ny besked",
            tekst: `Ny besked om "${titel}": ${String(mine[0].content ?? "").slice(0, 120)}`,
            link,
            data,
          }
        : {
            titel: `${mine.length} nye beskeder`,
            tekst: `Du har ${mine.length} nye beskeder om "${titel}".`,
            link,
            data,
          };
    // Ingen noegle her: beskedernes nøgler er allerede claimet ovenfor.
    await send(g.modtager, "ny_besked", input);
    antal++;
  }
  return antal;
}

// Kører fra betalings-cron'en (hvert 5. minut). Kaster aldrig.
export async function koerNotifikationsCron() {
  const admin = createAdminClient();
  const resultat = {
    advarsler: 0,
    bud: 0,
    likes: 0,
    slutterSnart: 0,
    nyAuktion: 0,
    beskeder: 0,
  };
  let start: Date | null = null;
  try {
    start = await hentStart(admin);
  } catch (err) {
    console.error("Notifikations-cron: start_kl kunne ikke hentes:", err);
  }
  const trin: [keyof typeof resultat, () => Promise<number>][] = [];
  if (start) {
    const s = start;
    trin.push(
      ["advarsler", () => advarsler(admin, s)],
      ["bud", () => bud(admin, s)],
      ["likes", () => likes(admin, s)],
    );
  }
  // "Slutter snart" handler om nu og fremad og kræver ikke start_kl.
  trin.push(["slutterSnart", () => slutterSnart(admin)]);
  if (start) {
    const s = start;
    trin.push(
      ["nyAuktion", () => nyAuktionFraFulgt(admin, s)],
      ["beskeder", () => beskeder(admin, s)],
    );
  }
  for (const [navn, fn] of trin) {
    try {
      resultat[navn] = await fn();
    } catch (err) {
      console.error(`Notifikations-cron (${navn}) fejlede:`, err);
    }
  }
  return resultat;
}
