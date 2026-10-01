"use server";

import { createClient } from "@/lib/supabase/server";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";

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
          ? `Dit bud skal være mindst ${kr} kr (10% over nuværende bud).`
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

  return { ok: true, slutterKl: efter?.slutter_kl ?? null };
}
