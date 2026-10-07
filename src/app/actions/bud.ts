"use server";

import { after } from "next/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { notificerEgetNyesteBud } from "@/lib/notifikationer/bud";
import { ERHVERV_FEJL } from "@/lib/erhverv/regler";

// Bud afgives paa serveren, saa det kan rate-limites pr. bruger og pr. IP.
// Selve buddet indsaettes stadig med brugerens egen session, saa RLS
// (bids_insert_own) og triggerne (minimumsbud, egen auktion, suspension,
// anti-sniping) gaelder uaendret. Fejl RETURNERES.

// handle_new_bid afviser et bud, hvis sælgeren har redigeret auktionen,
// siden byderen hentede siden (bids.auktion_redigeret_kl).
const AUKTION_AENDRET = "Sælgeren har lige ændret auktionen. Se den igen, før du byder.";

// Autobud: et andet maksimum på præcis samme beløb er sat før buddet og
// fører (samme_bud i autobud_afgoer) - buddet afvises.
const SAMME_BUD = "En anden byder har allerede budt det samme – byd mere.";

// Ukendte fejl (fx en fejl i autobud-motoren, som ruller hele buddet
// tilbage) logges i drift og vises aldrig ordret.
const NOGET_GIK_GALT = "Noget gik galt – prøv igen.";

// Efter buddet: fører byderen stadig, og hvad er det højeste bud? (Et
// maksimum kan have overbudt ham i samme transaktion.) Admin-klient, fordi
// bud ikke kan læses direkte - kun byderens egen status sendes tilbage.
async function minStatus(
  auktionId: string,
  brugerId: string,
): Promise<{ slutterKl: string | null; foerer: boolean | null; nuvaerendeBud: number | null }> {
  try {
    const admin = createAdminClient();
    const [{ data: a }, { data: top }] = await Promise.all([
      admin
        .from("auctions")
        .select("slutter_kl, nuværende_bud")
        .eq("id", auktionId)
        .maybeSingle<{ slutter_kl: string; "nuværende_bud": number | string | null }>(),
      admin
        .from("bids")
        .select("bruger_id")
        .eq("auktion_id", auktionId)
        .order("beløb", { ascending: false })
        .order("oprettet", { ascending: true })
        .limit(1)
        .maybeSingle<{ bruger_id: string }>(),
    ]);
    return {
      slutterKl: a?.slutter_kl ?? null,
      foerer: top ? top.bruger_id === brugerId : null,
      nuvaerendeBud: a?.["nuværende_bud"] != null ? Number(a["nuværende_bud"]) : null,
    };
  } catch (err) {
    console.error("Budstatus kunne ikke hentes:", err);
    return { slutterKl: null, foerer: null, nuvaerendeBud: null };
  }
}

// Danske fejltekster fra bud-triggerne, som maa vises ordret.
const KENDTE_BUDFEJL = [
  "Auktionen er allerede slut",
  "Buddet skal være i hele kroner.",
  "Auktionen er ikke aktiv længere",
  "Auktionen er ikke tilgængelig",
  // handle_new_bid: BidHamr har sat auktionen på pause (6. okt. 2026).
  "Auktionen er sat på pause",
  "Auktionen findes ikke",
  "Buddet skal være højere end nuværende bud",
  "Din konto er suspenderet, og du kan ikke byde.",
  // handle_new_bid: sælgeren har blokeret/spærret byderen.
  "Sælgeren har spærret dig fra at byde på sine auktioner.",
  "Du skal være logget ind.",
  "Du har prøvet for mange gange. Vent lidt, og prøv så igen.",
  AUKTION_AENDRET,
];

export async function afgivBud(
  auktionId: string,
  beloeb: number,
  beskyttelse: boolean,
  // auctions.redigeret_kl, som byderen så. Valgfri for bagudkompatibilitet.
  redigeretKl?: string | null,
): Promise<
  | { ok: true; slutterKl: string | null; foerer: boolean | null; nuvaerendeBud: number | null }
  | { fejl: string; auktionAendret?: true }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind for at byde." };

  if (
    typeof auktionId !== "string" ||
    !Number.isFinite(beloeb) ||
    !Number.isInteger(beloeb) ||
    beloeb <= 0
  ) {
    return { fejl: "Ugyldigt bud." };
  }
  const version =
    typeof redigeretKl === "string" && !Number.isNaN(Date.parse(redigeretKl))
      ? redigeretKl
      : null;

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
    auktion_redigeret_kl: version,
  });

  if (error) {
    const besked = error.message ?? "";
    // Databasens fejltekst sendes aldrig ordret til brugeren - kun kendte
    // beskeder (whitelist). Alt andet logges og giver en generisk besked.
    if (besked.includes("own_auction")) return { fejl: "Du kan ikke byde på din egen auktion." };
    if (besked.includes("erhverv_kan_ikke_byde")) return { fejl: ERHVERV_FEJL.kanIkkeByde };
    if (besked.includes("minimum_bid")) {
      const kr = Number(besked.match(/mindst\s+([\d.]+)\s*kr/)?.[1]);
      return {
        fejl: Number.isFinite(kr) && kr > 0
          ? `Dit bud skal være mindst ${kr.toLocaleString("da-DK")} kr.`
          : "Dit bud er for lavt.",
      };
    }
    if (besked.includes("samme_bud")) return { fejl: SAMME_BUD };
    if (besked.includes(AUKTION_AENDRET)) {
      return { fejl: AUKTION_AENDRET, auktionAendret: true };
    }
    const kendt = KENDTE_BUDFEJL.find((k) => besked.includes(k));
    if (kendt) return { fejl: kendt };
    console.error("afgivBud fejlede:", error.code, besked);
    await logDriftFejl({ kilde: "action", hvor: "afgivBud", fejl: error, brugerId: user.id });
    return { fejl: NOGET_GIK_GALT };
  }

  // Anti-sniping sker i handle_new_bid (også for automatiske bud i samme
  // transaktion); returnér det nye sluttidspunkt og min status.
  const status = await minStatus(auktionId, user.id);

  // Overbudt + bud på egen auktion sendes efter svaret, så budgiveren ikke
  // venter på mail/push. Den forrige førende findes ud fra bud-rækkefølgen
  // (efter insert). Notifikations-cron'en bruger samme nøgler og opsamler bud
  // fra appen og fejlede afsendelser - intet sendes dobbelt.
  const byder = user.id;
  after(() => notificerEgetNyesteBud(auktionId, byder));

  return { ok: true, ...status };
}

// Automatisk bud (maksimum) - se ROADMAP-BESLUTNINGER.md, "Autobud".
// public.saet_maksimum gemmer det hemmelige maksimum og byder (fører man
// ikke) det mindst mulige; maksimumbud afgøres i databasen under
// auktionslåsen. Maksimum sendes aldrig til andre end byderen selv.
export async function saetMaksimum(
  auktionId: string,
  maks: number,
  // Fører byderen, kan BidHamr Beskyttelse ikke ændres (den følger hans
  // førende bud) - budpanelet sender så den nuværende værdi.
  beskyttelse: boolean,
  redigeretKl?: string | null,
): Promise<
  | {
      ok: true;
      foerer: boolean;
      nuvaerendeBud: number | null;
      maks: number;
      slutterKl: string | null;
      budAfgivet: boolean;
    }
  | { fejl: string; auktionAendret?: true }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind for at byde." };

  if (
    typeof auktionId !== "string" ||
    !Number.isFinite(maks) ||
    !Number.isInteger(maks) ||
    maks <= 0
  ) {
    return { fejl: "Skriv dit maksimum i hele kroner." };
  }
  const version =
    typeof redigeretKl === "string" && !Number.isNaN(Date.parse(redigeretKl))
      ? redigeretKl
      : null;

  const ip = await klientIp();
  if (!(await tjekGraenser([["bud_bruger", user.id], ["bud_ip", ip]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  const { data, error } = await supabase.rpc("saet_maksimum", {
    p_auktion: auktionId,
    p_maks: maks,
    p_beskyttelse: beskyttelse === true,
    p_auktion_redigeret_kl: version,
  });

  if (error) {
    const besked = error.message ?? "";
    const kr = (re: RegExp) => Number(besked.match(re)?.[1]);
    if (besked.includes("own_auction")) return { fejl: "Du kan ikke byde på din egen auktion." };
    if (besked.includes("erhverv_kan_ikke_byde")) return { fejl: ERHVERV_FEJL.kanIkkeByde };
    if (besked.includes("maks_for_lavt")) {
      const v = kr(/mindst\s+([\d.]+)\s*kr/);
      return {
        fejl:
          Number.isFinite(v) && v > 0
            ? `Dit maksimum skal være mindst ${v.toLocaleString("da-DK")} kr.`
            : "Dit maksimum er for lavt.",
      };
    }
    if (besked.includes("maks_under_bud")) {
      const v = kr(/med\s+([\d.]+)\s*kr/);
      return {
        fejl:
          Number.isFinite(v) && v > 0
            ? `Du fører med ${v.toLocaleString("da-DK")} kr. Dit maksimum kan ikke være lavere end dit nuværende bud.`
            : "Dit maksimum kan ikke være lavere end dit nuværende bud.",
      };
    }
    if (besked.includes("maks_ugyldigt")) return { fejl: "Dit maksimum er ugyldigt." };
    // Nogen bød lige før dig (mindstebuddet steg) - bed om at prøve igen.
    if (besked.includes("minimum_bid")) {
      return { fejl: "En anden har lige budt. Se det nye bud, og prøv igen." };
    }
    if (besked.includes("samme_bud")) return { fejl: SAMME_BUD };
    if (besked.includes("beskyttelse_laast")) {
      return {
        fejl: "Du fører allerede. BidHamr Beskyttelse følger dit bud og kan ikke ændres, mens du fører.",
      };
    }
    if (besked.includes("Kontoen er slettet")) return { fejl: "Du kan ikke byde." };
    if (besked.includes(AUKTION_AENDRET)) {
      return { fejl: AUKTION_AENDRET, auktionAendret: true };
    }
    const kendt = KENDTE_BUDFEJL.find((k) => besked.includes(k));
    if (kendt) return { fejl: kendt };
    console.error("saetMaksimum fejlede:", error.code, besked);
    await logDriftFejl({ kilde: "action", hvor: "saetMaksimum", fejl: error, brugerId: user.id });
    return { fejl: NOGET_GIK_GALT };
  }

  const svar = (data ?? {}) as {
    foerer?: boolean;
    nuvaerende_bud?: number | string | null;
    maks_beloeb?: number | string;
    slutter_kl?: string | null;
    bud_afgivet?: boolean;
  };

  // Overbudt + bud på egen auktion - også for de automatiske bud i samme
  // runde. Samme nøgler som cron'en, så intet sendes dobbelt.
  if (svar.bud_afgivet) {
    const byder = user.id;
    after(() => notificerEgetNyesteBud(auktionId, byder));
  }

  return {
    ok: true,
    foerer: svar.foerer === true,
    nuvaerendeBud: svar.nuvaerende_bud != null ? Number(svar.nuvaerende_bud) : null,
    maks: Number(svar.maks_beloeb ?? maks),
    slutterKl: svar.slutter_kl ?? null,
    budAfgivet: svar.bud_afgivet === true,
  };
}
