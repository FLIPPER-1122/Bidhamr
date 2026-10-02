import "server-only";

// Notifikationer om nye bud: "du er overbudt" (til den, der førte lige før
// buddet) og "nyt bud på din auktion" (til sælgeren).
//
// Bruges to steder med SAMME nøgler, så intet sendes dobbelt:
// - afgivBud (hjemmesiden) sender med det samme efter svaret.
// - notifikations-cron'en opsamler bud, der ikke kom gennem afgivBud (appen
//   indsætter bud direkte via RLS) eller hvor afsendelsen fejlede.
//
// Den forrige førende findes ud fra bud-rækkefølgen (bud skal altid være
// højere end det forrige, så det højeste bud under dette er det, der førte
// lige før) - ikke fra "seneste bud" læst før insert, som kan være forældet.
//
// Bydere er private: byderens identitet nævnes aldrig, og ingen bruger-id
// lægges i data.
import { createAdminClient } from "@/lib/supabase/admin";
import { send, type SendOptions } from "@/lib/notifikationer/send";

type Admin = ReturnType<typeof createAdminClient>;

export type NytBud = {
  id: string;
  auktion_id: string;
  bruger_id: string;
  beloeb: number;
};

export type BudAuktion = { titel: string; bruger_id: string };

// Nøglerne. bud_paa_egen sendes altid sidst og bruges af cron'en som
// "færdigbehandlet"-markør for buddet.
export const overbudtNoegle = (budId: string) => `overbudt:${budId}`;
export const budPaaEgenNoegle = (budId: string) => `bud_paa_egen:${budId}`;

// Hvem førte lige før dette bud? null, hvis det er det første bud.
export async function foerendeFoer(admin: Admin, bud: NytBud): Promise<string | null> {
  const { data, error } = await admin
    .from("bids")
    .select("bruger_id")
    .eq("auktion_id", bud.auktion_id)
    .lt("beløb", bud.beloeb)
    .order("beløb", { ascending: false })
    .order("oprettet", { ascending: false })
    .limit(1)
    .maybeSingle<{ bruger_id: string }>();
  if (error) throw new Error(`Forrige bud kunne ikke hentes: ${error.message}`);
  return data?.bruger_id ?? null;
}

// Hvem fører auktionen lige nu (højeste bud)? null, hvis ingen bud.
export async function foerendeNu(admin: Admin, auktionId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("bids")
    .select("bruger_id")
    .eq("auktion_id", auktionId)
    .order("beløb", { ascending: false })
    .order("oprettet", { ascending: false })
    .limit(1)
    .maybeSingle<{ bruger_id: string }>();
  if (error) throw new Error(`Førende bud kunne ikke hentes: ${error.message}`);
  return data?.bruger_id ?? null;
}

// Sender begge notifikationer for ét bud. Kaster ikke på grund af send()
// (som aldrig kaster), men kan kaste, hvis opslaget af forrige/førende bud
// fejler - så sendes intet, og cron'en prøver igen.
export async function notificerBud(
  admin: Admin,
  bud: NytBud,
  auktion: BudAuktion,
  opts: SendOptions = {},
) {
  const forrige = await foerendeFoer(admin, bud);
  const kr = bud.beloeb.toLocaleString("da-DK");
  const link = `/auktion/${bud.auktion_id}`;
  const data = { auction_id: bud.auktion_id };

  // Ikke hvis den førende overbyder sig selv, og aldrig til sælgeren. Heller
  // ikke, hvis den forrige førende har budt igen og fører nu - cron'en kan
  // behandle buddet minutter senere, og afgivBud kører efter svaret.
  if (
    forrige &&
    forrige !== bud.bruger_id &&
    forrige !== auktion.bruger_id &&
    (await foerendeNu(admin, bud.auktion_id)) !== forrige
  ) {
    await send(
      forrige,
      "overbudt",
      {
        titel: "Du er blevet overbudt",
        tekst: `Der er budt ${kr} kr på "${auktion.titel}". Byd igen, hvis du stadig vil have den.`,
        link,
        data,
        noegle: overbudtNoegle(bud.id),
      },
      opts,
    );
  }
  if (auktion.bruger_id !== bud.bruger_id) {
    await send(
      auktion.bruger_id,
      "bud_paa_egen",
      {
        titel: "Nyt bud på din auktion",
        tekst: `Der er budt ${kr} kr på "${auktion.titel}".`,
        link,
        data,
        noegle: budPaaEgenNoegle(bud.id),
      },
      opts,
    );
  }
}

// Markerer et bud som færdigbehandlet uden at sende noget (fx når auktionen
// er slut, eller sælgeren selv har budt), så cron'en ikke henter det igen.
// Kaster ikke; fejler det, prøver næste kørsel igen.
export async function markerBudBehandlet(admin: Admin, budId: string, saelgerId: string) {
  const { error } = await admin
    .from("notifikation_afsendelser")
    .upsert(
      { noegle: budPaaEgenNoegle(budId), bruger_id: saelgerId, type: "bud_paa_egen" },
      { onConflict: "noegle", ignoreDuplicates: true },
    );
  if (error) console.error("Notifikationer: bud", budId, "kunne ikke markeres:", error.message);
}

// Til afgivBud: finder brugerens netop afgivne bud (hans højeste på
// auktionen, da bud altid stiger) og sender. Kaster aldrig.
export async function notificerEgetNyesteBud(auktionId: string, byderId: string) {
  try {
    const admin = createAdminClient();
    const [{ data: bud }, { data: a }] = await Promise.all([
      admin
        .from("bids")
        .select("id, auktion_id, bruger_id, beløb")
        .eq("auktion_id", auktionId)
        .eq("bruger_id", byderId)
        .order("beløb", { ascending: false })
        .order("oprettet", { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string; auktion_id: string; bruger_id: string; "beløb": number | string }>(),
      admin
        .from("auctions")
        .select("titel, bruger_id")
        .eq("id", auktionId)
        .maybeSingle<BudAuktion>(),
    ]);
    if (!bud || !a) return;
    await notificerBud(
      admin,
      { id: bud.id, auktion_id: bud.auktion_id, bruger_id: bud.bruger_id, beloeb: Number(bud["beløb"]) },
      a,
    );
  } catch (err) {
    console.error("Bud-notifikationer fejlede:", err);
  }
}
