"use server";

import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { send } from "@/lib/notifikationer/send";

// Overbudt (forrige førende byder) og bud på egen auktion (sælgeren).
// Byderens identitet nævnes aldrig (bydere er private). Kaster aldrig.
async function notificerOmBud(
  auktionId: string,
  byderId: string,
  forrigeByder: string | null,
  beloeb: number,
) {
  try {
    const { data: a } = await createAdminClient()
      .from("auctions")
      .select("titel, bruger_id")
      .eq("id", auktionId)
      .maybeSingle<{ titel: string; bruger_id: string }>();
    if (!a) return;
    const kr = beloeb.toLocaleString("da-DK");
    const link = `/auktion/${auktionId}`;
    const data = { auction_id: auktionId };
    await Promise.all([
      forrigeByder && forrigeByder !== byderId
        ? send(forrigeByder, "overbudt", {
            titel: "Du er blevet overbudt",
            tekst: `Der er budt ${kr} kr på "${a.titel}". Byd igen, hvis du stadig vil have den.`,
            link,
            data,
            noegle: `overbudt:${auktionId}:${forrigeByder}:${beloeb}`,
          })
        : null,
      a.bruger_id !== byderId
        ? send(a.bruger_id, "bud_paa_egen", {
            titel: "Nyt bud på din auktion",
            tekst: `Der er budt ${kr} kr på "${a.titel}".`,
            link,
            data,
            noegle: `bud_paa_egen:${auktionId}:${beloeb}`,
          })
        : null,
    ]);
  } catch (err) {
    console.error("Bud-notifikationer fejlede:", err);
  }
}

// Bud afgives paa serveren, saa det kan rate-limites pr. bruger og pr. IP.
// Selve buddet indsaettes stadig med brugerens egen session, saa RLS
// (bids_insert_own) og triggerne (minimumsbud, egen auktion, suspension,
// anti-sniping) gaelder uaendret. Fejl RETURNERES.

// Danske fejltekster fra bud-triggerne, som maa vises ordret.
const KENDTE_BUDFEJL = [
  "Auktionen er allerede slut",
  "Auktionen er ikke aktiv længere",
  "Auktionen er ikke tilgængelig",
  "Auktionen findes ikke",
  "Buddet skal være højere end nuværende bud",
  "Din konto er suspenderet, og du kan ikke byde.",
  "Du skal være logget ind.",
  "Du har prøvet for mange gange. Vent lidt, og prøv så igen.",
];

export async function afgivBud(
  auktionId: string,
  beloeb: number,
  beskyttelse: boolean,
): Promise<{ ok: true; slutterKl: string | null } | { fejl: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { fejl: "Du skal være logget ind for at byde." };

  if (typeof auktionId !== "string" || !Number.isFinite(beloeb) || beloeb <= 0) {
    return { fejl: "Ugyldigt bud." };
  }

  const ip = await klientIp();
  if (!(await tjekGraenser([["bud_bruger", user.id], ["bud_ip", ip]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  // Hvem førte før dette bud? Bud skal altid være højere end det forrige, så
  // det seneste bud er det førende. Hentes med service-role (bydere er
  // private) og bruges kun til notifikationen - sendes aldrig til browseren.
  const { data: forrige } = await createAdminClient()
    .from("bids")
    .select("bruger_id")
    .eq("auktion_id", auktionId)
    .order("oprettet", { ascending: false })
    .limit(1)
    .maybeSingle<{ bruger_id: string }>();

  const { error } = await supabase.from("bids").insert({
    auktion_id: auktionId,
    bruger_id: user.id,
    beløb: beloeb,
    // Kun et oenske - beloebet beregnes i databasen, naar auktionen slutter.
    beskyttelse: beskyttelse === true,
  });

  if (error) {
    const besked = error.message ?? "";
    // Databasens fejltekst sendes aldrig ordret til brugeren - kun kendte
    // beskeder (whitelist). Alt andet logges og giver en generisk besked.
    if (besked.includes("own_auction")) return { fejl: "Du kan ikke byde på din egen auktion." };
    if (besked.includes("minimum_bid")) {
      const kr = besked.match(/mindst\s+([\d.,]+)\s*kr/)?.[1];
      return {
        fejl: kr
          ? `Dit bud skal være mindst ${kr} kr.`
          : "Dit bud er for lavt.",
      };
    }
    const kendt = KENDTE_BUDFEJL.find((k) => besked.includes(k));
    if (kendt) return { fejl: kendt };
    console.error("afgivBud fejlede:", error.code, besked);
    return { fejl: "Dit bud kunne ikke afgives. Prøv igen." };
  }

  // Anti-sniping sker i handle_new_bid; returnér det nye sluttidspunkt.
  const { data: efter } = await supabase
    .from("auctions")
    .select("slutter_kl")
    .eq("id", auktionId)
    .maybeSingle<{ slutter_kl: string }>();

  // Notifikationer sendes efter svaret, så budgiveren ikke venter på mail/push.
  const forrigeByder = forrige?.bruger_id ?? null;
  const byder = user.id;
  after(() => notificerOmBud(auktionId, byder, forrigeByder, beloeb));

  return { ok: true, slutterKl: efter?.slutter_kl ?? null };
}
