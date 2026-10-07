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
  // bids.oprettet - samler buddet med de automatiske bud i samme runde.
  oprettet?: string;
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

// Automatisk bud (autobud): et bud og de automatiske bud, det udløste,
// indsættes i samme transaktion og har derfor præcis samme tidspunkt
// (bids.oprettet = now()). Sådan en "runde" giver højst ÉN notifikation til
// hver: sælgeren får det endelige bud, og alle, der førte før runden eller
// bød i runden og ikke fører efter den, får "overbudt" én gang. Den, der
// fører med sit maksimum, får ingen besked for hvert automatiske bud.
type RundeBud = { id: string; bruger_id: string; beloeb: number };

async function hentRunde(admin: Admin, bud: NytBud): Promise<RundeBud[]> {
  let oprettet = bud.oprettet ?? null;
  if (!oprettet) {
    const { data, error } = await admin
      .from("bids")
      .select("oprettet")
      .eq("id", bud.id)
      .maybeSingle<{ oprettet: string }>();
    if (error) throw new Error(`Buddet kunne ikke hentes: ${error.message}`);
    oprettet = data?.oprettet ?? null;
  }
  if (!oprettet) return [{ id: bud.id, bruger_id: bud.bruger_id, beloeb: bud.beloeb }];
  const { data, error } = await admin
    .from("bids")
    .select("id, bruger_id, beløb")
    .eq("auktion_id", bud.auktion_id)
    .eq("oprettet", oprettet)
    .order("beløb", { ascending: true })
    .limit(20)
    .overrideTypes<{ id: string; bruger_id: string; beløb: number | string }[], { merge: false }>();
  if (error) throw new Error(`Budrunden kunne ikke hentes: ${error.message}`);
  const runde = (data ?? []).map((b) => ({ id: b.id, bruger_id: b.bruger_id, beloeb: Number(b.beløb) }));
  return runde.length > 0 ? runde : [{ id: bud.id, bruger_id: bud.bruger_id, beloeb: bud.beloeb }];
}

// Sender notifikationerne for den budrunde, buddet hører til. Kaster ikke på
// grund af send() (som aldrig kaster), men kan kaste, hvis opslagene fejler -
// så sendes intet, og cron'en prøver igen.
export async function notificerBud(
  admin: Admin,
  bud: NytBud,
  auktion: BudAuktion,
  opts: SendOptions = {},
) {
  const runde = await hentRunde(admin, bud);
  const sidste = runde[runde.length - 1];
  const kr = sidste.beloeb.toLocaleString("da-DK");
  const link = `/auktion/${bud.auktion_id}`;
  const data = { auction_id: bud.auktion_id };

  // Rundens øvrige bud markeres som behandlet (ingen egen notifikation).
  for (const b of runde.slice(0, -1)) {
    await markerBudBehandlet(admin, b.id, auktion.bruger_id);
  }

  // Hvem førte før runden, og hvem førte lige før det endelige bud?
  const foerFoerRunde = await foerendeFoer(admin, {
    ...bud,
    beloeb: runde[0].beloeb,
  });
  const forrigeForSidste =
    runde.length > 1 ? runde[runde.length - 2].bruger_id : foerFoerRunde;
  // Ikke til den, der fører nu (fx har budt igen), og aldrig til sælgeren.
  const nu = await foerendeNu(admin, bud.auktion_id);
  const overbudte = [
    ...new Set([foerFoerRunde, ...runde.map((b) => b.bruger_id)]),
  ].filter(
    (u): u is string =>
      !!u && u !== sidste.bruger_id && u !== auktion.bruger_id && u !== nu,
  );

  // Eget maksimum (kun til modtageren selv - aldrig til andre).
  const maksimum = new Map<string, number>();
  if (overbudte.length > 0) {
    const { data: maks, error } = await admin
      .from("bud_maksimum")
      .select("bruger_id, maks_beloeb")
      .eq("auktion_id", bud.auktion_id)
      .in("bruger_id", overbudte)
      .overrideTypes<{ bruger_id: string; maks_beloeb: number | string }[], { merge: false }>();
    if (error) throw new Error(`Maksimum kunne ikke hentes: ${error.message}`);
    for (const m of maks ?? []) maksimum.set(m.bruger_id, Number(m.maks_beloeb));
    // Har byderen budt manuelt over sit maksimum, var det ikke maksimum,
    // der blev nået - så sendes den almindelige besked.
    if (maksimum.size > 0) {
      const { data: egne, error: egneFejl } = await admin
        .from("bids")
        .select("bruger_id, beløb")
        .eq("auktion_id", bud.auktion_id)
        .in("bruger_id", [...maksimum.keys()])
        .order("beløb", { ascending: false })
        .limit(200)
        .overrideTypes<{ bruger_id: string; beløb: number | string }[], { merge: false }>();
      if (egneFejl) throw new Error(`Egne bud kunne ikke hentes: ${egneFejl.message}`);
      for (const b of egne ?? []) {
        const m = maksimum.get(b.bruger_id);
        if (m !== undefined && Number(b.beløb) > m) maksimum.delete(b.bruger_id);
      }
    }
  }

  for (const u of overbudte) {
    const maks = maksimum.get(u);
    const naaet = maks !== undefined && maks <= sidste.beloeb;
    await send(
      u,
      "overbudt",
      naaet
        ? {
            titel: "Du er blevet overbudt – dit maksimum er nået",
            tekst: `Dit maksimum på ${maks.toLocaleString("da-DK")} kr på "${auktion.titel}" er nået. Det højeste bud er nu ${kr} kr. Hæv dit maksimum, hvis du stadig vil have varen.`,
            link,
            data,
            noegle: u === forrigeForSidste ? overbudtNoegle(sidste.id) : `${overbudtNoegle(sidste.id)}:${u}`,
          }
        : {
            titel: "Du er blevet overbudt",
            tekst: `Det højeste bud på "${auktion.titel}" er nu ${kr} kr. Byd igen, hvis du stadig vil have varen.`,
            link,
            data,
            noegle: u === forrigeForSidste ? overbudtNoegle(sidste.id) : `${overbudtNoegle(sidste.id)}:${u}`,
          },
      opts,
    );
  }
  if (auktion.bruger_id !== sidste.bruger_id) {
    await send(
      auktion.bruger_id,
      "bud_paa_egen",
      {
        titel: "Nyt bud på din auktion",
        tekst: `Der er afgivet et bud på ${kr} kr på "${auktion.titel}".`,
        link,
        data,
        noegle: budPaaEgenNoegle(sidste.id),
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
        .select("id, auktion_id, bruger_id, beløb, oprettet")
        .eq("auktion_id", auktionId)
        .eq("bruger_id", byderId)
        .order("beløb", { ascending: false })
        .order("oprettet", { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string; auktion_id: string; bruger_id: string; "beløb": number | string; oprettet: string }>(),
      admin
        .from("auctions")
        .select("titel, bruger_id")
        .eq("id", auktionId)
        .maybeSingle<BudAuktion>(),
    ]);
    if (!bud || !a) return;
    await notificerBud(
      admin,
      {
        id: bud.id,
        auktion_id: bud.auktion_id,
        bruger_id: bud.bruger_id,
        beloeb: Number(bud["beløb"]),
        oprettet: bud.oprettet,
      },
      a,
    );
  } catch (err) {
    console.error("Bud-notifikationer fejlede:", err);
  }
}
