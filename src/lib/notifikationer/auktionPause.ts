import "server-only";

// Beskeder, når en skjult auktion sættes på pause eller åbner igen
// (Filip, 6. oktober 2026 - migration 20261009040000_skjult_auktion_pause.sql).
//
// Databasen (triggeren auctions_pause_skjult) sætter pausen og genoptager
// den - uanset hvilken staff-funktion der skjuler eller viser auktionen - og
// skriver en række i auktion_pauser. Herfra sendes beskederne:
// - Pause: byderne får "Auktionen er sat på pause ...". Sælgeren får den
//   eksisterende begrundelse (DSA) og ikke en ekstra besked.
// - Genoptaget: sælger og bydere får "Auktionen er åben igen og slutter ...".
//
// Kaldes lige efter staff-handlingen (after()) og fra notifikations-cron'en
// som sikkerhedsnet. Nøglerne (auktion_pauset:/auktion_genoptaget:<pause-id>:
// <bruger>) sikrer, at ingen får samme besked to gange. Kaster aldrig.
import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { fristDato } from "@/lib/betalingsfrist";
import { logDriftFejl } from "@/lib/drift";

type Admin = ReturnType<typeof createAdminClient>;

// Hvor langt tilbage cron'en kigger efter pauser, der mangler besked.
const VINDUE_MS = 48 * 60 * 60 * 1000;

export const PAUSE_TEKST =
  "Auktionen er sat på pause, mens BidHamr kigger på den. Dit bud gælder stadig.";

export function genoptagetTekst(slutterKl: string): string {
  return `Auktionen er åben igen og slutter ${fristDato(slutterKl)}.`;
}

type PauseRaekke = {
  id: string;
  auction_id: string;
  pauset_kl: string;
  genoptaget_kl: string | null;
  ny_slutter_kl: string | null;
  fra_oprydning: boolean;
};

async function bydere(admin: Admin, auktionId: string, saelgerId: string): Promise<string[]> {
  const { data } = await admin.from("bids").select("bruger_id").eq("auktion_id", auktionId).limit(1000);
  return [...new Set((data ?? []).map((b) => b.bruger_id as string))].filter((b) => b !== saelgerId);
}

async function behandl(admin: Admin, p: PauseRaekke): Promise<number> {
  const { data: auktion } = await admin
    .from("auctions")
    .select("titel, bruger_id, status, slutter_kl")
    .eq("id", p.auction_id)
    .maybeSingle<{ titel: string; bruger_id: string; status: string; slutter_kl: string }>();
  if (!auktion) return 0;
  const titel = auktion.titel ? `"${auktion.titel}"` : "En auktion";
  const link = `/auktion/${p.auction_id}`;
  const data = { auction_id: p.auction_id };
  const modtagere = await bydere(admin, p.auction_id, auktion.bruger_id);
  let sendt = 0;

  if (p.genoptaget_kl) {
    // Kun hvis den stadig kører (ikke fjernet igen i mellemtiden).
    if (auktion.status !== "aktiv") return 0;
    const slut = p.ny_slutter_kl ?? auktion.slutter_kl;
    for (const bruger of [auktion.bruger_id, ...modtagere]) {
      const r = await send(
        bruger,
        "auktion_status",
        {
          titel: `${titel} er åben igen`,
          tekst: genoptagetTekst(slut),
          link,
          data,
          noegle: `auktion_genoptaget:${p.id}:${bruger}`,
        },
        { springOverVedClaimFejl: true },
      );
      if (r.klokke || r.mail || r.push) sendt++;
    }
    return sendt;
  }

  // Pauset (og endnu ikke genoptaget). Ingen besked for pauser fra
  // engangs-oprydningen - de bydere har allerede fået besked om skjul.
  if (p.fra_oprydning) return 0;
  for (const bruger of modtagere) {
    const r = await send(
      bruger,
      "auktion_status",
      {
        titel: `${titel} er sat på pause`,
        tekst: PAUSE_TEKST,
        link,
        data,
        noegle: `auktion_pauset:${p.id}:${bruger}`,
      },
      { springOverVedClaimFejl: true },
    );
    if (r.klokke || r.mail || r.push) sendt++;
  }
  return sendt;
}

// Sender de beskeder, der mangler for pauser og genoptagelser de seneste 48
// timer - eller kun for én auktion. Returnerer antal sendte beskeder.
export async function notificerAuktionPauser(auktionId?: string): Promise<number> {
  try {
    const admin = createAdminClient();
    const fra = new Date(Date.now() - VINDUE_MS).toISOString();
    let q = admin
      .from("auktion_pauser")
      .select("id, auction_id, pauset_kl, genoptaget_kl, ny_slutter_kl, fra_oprydning")
      .or(`pauset_kl.gte.${fra},genoptaget_kl.gte.${fra}`)
      .order("pauset_kl", { ascending: false })
      .limit(200);
    if (auktionId) q = q.eq("auction_id", auktionId);
    const { data, error } = await q.overrideTypes<PauseRaekke[], { merge: false }>();
    if (error) throw new Error(error.message);
    // Kun den nyeste pause pr. auktion: er en auktion skjult og vist flere
    // gange, før beskeden blev sendt, gælder kun den seneste status og sluttid.
    const nyeste = new Map<string, PauseRaekke>();
    for (const p of data ?? []) if (!nyeste.has(p.auction_id)) nyeste.set(p.auction_id, p);
    let i = 0;
    for (const p of nyeste.values()) i += await behandl(admin, p);
    return i;
  } catch (err) {
    await logDriftFejl({ kilde: "notifikation", hvor: "auktion på pause", fejl: err });
    return 0;
  }
}
