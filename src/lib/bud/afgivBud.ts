import "server-only";

// Bud og maksimumbud - ÉN kodevej for hjemmesidens server actions
// (src/app/actions/bud.ts) og appens endpoint (POST /api/bud/app,
// docs/APP-ENDPOINTS.md).
//
// Buddet indsættes med brugerens EGEN session (supabase kalder databasen som
// brugeren), så RLS (bids_insert_own) og triggerne (minimumsbud, egen
// auktion, suspension, MitID, vilkår, kunst-kontrol, frosset sælger,
// anti-sniping) gælder uændret. Rate limit pr. bruger og pr. IP.
// Fejl RETURNERES som { fejl, kode }: fejl er en dansk tekst, kode er
// databasens BH-kode (fx BHU03), når den findes, ellers en fast kode
// (own_auction, samme_bud, minimum_bid ...).

import { after } from "next/server";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { BUD_SAELGER_FROSSET_TEKST, erBudSaelgerFrossetFejl } from "@/lib/betaling/frosset";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { FOR_MANGE_FORSOEG, tjekGraenser } from "@/lib/rateLimit";
import { notificerEgetNyesteBud } from "@/lib/notifikationer/bud";
import { ERHVERV_FEJL } from "@/lib/erhverv/regler";
import { erMitIdFejl } from "@/lib/mitid/fejl";
import { MITID } from "@/lib/tekster/mitid";
import { erVilkaarFejl } from "@/lib/vilkaar";
import { KUNST_TEKST, erKunstBudFejl } from "@/lib/kunstForbud";
import { VILKAAR_TEKST } from "@/lib/tekster/vilkaar";
import { MAKS_BUD } from "@/lib/auktionRegler";

export type BudFejl = { fejl: string; kode: string; auktionAendret?: true; mitid?: true };

// handle_new_bid afviser et bud, hvis sælgeren har redigeret auktionen,
// siden byderen hentede siden (bids.auktion_redigeret_kl).
const AUKTION_AENDRET = "Sælgeren har lige ændret auktionen. Se den igen, før du byder.";

// Autobud: et andet maksimum på præcis samme beløb er sat før buddet og
// fører (samme_bud i autobud_afgoer) - buddet afvises.
const SAMME_BUD = "En anden byder har allerede budt det samme – byd mere.";

// Ukendte fejl logges i drift og vises aldrig ordret.
const NOGET_GIK_GALT = "Noget gik galt – prøv igen.";

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
  // Beløbsloft (Filip, 26. okt. 2026 - 20261031010000): højst 25.000 kr.
  "Det højeste tilladte bud er 25.000 kr.",
  "Dit maksimum kan højst være 25.000 kr.",
  // Sælgeren er frosset (fremmed udbetaling, 20261019010000).
  "Der kan ikke bydes på sælgerens auktioner lige nu.",
  AUKTION_AENDRET,
];

// Databasens egen BH-kode (fx BHU03), hvis fejlen har en.
function bhKode(error: PostgrestError): string | null {
  return typeof error.code === "string" && /^BH[A-Z0-9]{3}$/.test(error.code) ? error.code : null;
}

// Fælles for bud og maksimum: fejl, der betyder det samme begge steder.
function faellesFejl(error: PostgrestError, besked: string): BudFejl | null {
  const bh = bhKode(error);
  // MitID mangler (BHV01): budpanelet viser "Bekræft med MitID".
  if (erMitIdFejl(error.code, besked)) return { fejl: MITID.fejlMangler, kode: bh ?? "BHV01", mitid: true };
  // Brugerbetingelserne er ikke accepteret (BHV02).
  if (erVilkaarFejl(error.code, besked)) return { fejl: VILKAAR_TEKST.fejlMangler, kode: bh ?? "BHV02" };
  // Auktionen afventer kunst-kontrol (BHK01, 20261023010000_kunst_forbudt.sql).
  if (erKunstBudFejl(error.code, besked)) return { fejl: KUNST_TEKST.budAfvist, kode: bh ?? "BHK01" };
  if (besked.includes("own_auction")) return { fejl: "Du kan ikke byde på din egen auktion.", kode: "own_auction" };
  if (besked.includes("erhverv_kan_ikke_byde")) return { fejl: ERHVERV_FEJL.kanIkkeByde, kode: bh ?? "BHE01" };
  if (erBudSaelgerFrossetFejl(error.code, besked)) return { fejl: BUD_SAELGER_FROSSET_TEKST, kode: bh ?? "BHU03" };
  return null;
}

function sidsteFejl(error: PostgrestError, besked: string): BudFejl | null {
  if (besked.includes("samme_bud")) return { fejl: SAMME_BUD, kode: "samme_bud" };
  if (besked.includes(AUKTION_AENDRET)) return { fejl: AUKTION_AENDRET, kode: "auktion_aendret", auktionAendret: true };
  const kendt = KENDTE_BUDFEJL.find((k) => besked.includes(k));
  if (kendt) return { fejl: kendt, kode: bhKode(error) ?? "afvist" };
  return null;
}

// auctions.redigeret_kl, som byderen så - kun en gyldig dato bruges.
function versionFra(redigeretKl: unknown): string | null {
  return typeof redigeretKl === "string" && !Number.isNaN(Date.parse(redigeretKl)) ? redigeretKl : null;
}

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

// ------------------------------------------------------------------ bud

export type BudOk = { ok: true; slutterKl: string | null; foerer: boolean | null; nuvaerendeBud: number | null };

export async function afgivBudFor(
  supabase: SupabaseClient,
  brugerId: string,
  ip: string,
  auktionId: unknown,
  beloeb: unknown,
  beskyttelse: unknown,
  redigeretKl?: unknown,
): Promise<BudOk | BudFejl> {
  if (
    typeof auktionId !== "string" ||
    typeof beloeb !== "number" ||
    !Number.isFinite(beloeb) ||
    !Number.isInteger(beloeb) ||
    beloeb <= 0
  ) {
    return { fejl: "Ugyldigt bud.", kode: "ugyldig" };
  }
  if (beloeb > MAKS_BUD) return { fejl: "Det højeste tilladte bud er 25.000 kr.", kode: "BHB05" };
  const version = versionFra(redigeretKl);

  if (!(await tjekGraenser([["bud_bruger", brugerId], ["bud_ip", ip]]))) {
    return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
  }

  const { error } = await supabase.from("bids").insert({
    auktion_id: auktionId,
    bruger_id: brugerId,
    beløb: beloeb,
    // Ignoreres af databasen (20261031010000): BidHamr Beskyttelse er
    // inkluderet i gebyret ved forsendelse. Kolonnen bevares for appen.
    beskyttelse: beskyttelse === true,
    auktion_redigeret_kl: version,
  });

  if (error) {
    const besked = error.message ?? "";
    const f = faellesFejl(error, besked);
    if (f) return f;
    if (besked.includes("minimum_bid")) {
      const kr = Number(besked.match(/mindst\s+([\d.]+)\s*kr/)?.[1]);
      return {
        fejl:
          Number.isFinite(kr) && kr > 0 ? `Dit bud skal være mindst ${kr.toLocaleString("da-DK")} kr.` : "Dit bud er for lavt.",
        kode: "minimum_bid",
      };
    }
    const s = sidsteFejl(error, besked);
    if (s) return s;
    console.error("afgivBud fejlede:", error.code, besked);
    await logDriftFejl({ kilde: "action", hvor: "afgivBud", fejl: error, brugerId });
    return { fejl: NOGET_GIK_GALT, kode: "fejl" };
  }

  // Anti-sniping sker i handle_new_bid (også for automatiske bud i samme
  // transaktion); returnér det nye sluttidspunkt og min status.
  const status = await minStatus(auktionId, brugerId);

  // Overbudt + bud på egen auktion sendes efter svaret. Notifikations-cron'en
  // bruger samme nøgler - intet sendes dobbelt.
  after(() => notificerEgetNyesteBud(auktionId, brugerId));

  return { ok: true, ...status };
}

// ------------------------------------------------------------------ maksimum

export type MaksimumOk = {
  ok: true;
  foerer: boolean;
  nuvaerendeBud: number | null;
  maks: number;
  slutterKl: string | null;
  budAfgivet: boolean;
};

// Automatisk bud (maksimum) - se ROADMAP-BESLUTNINGER.md, "Autobud".
// public.saet_maksimum gemmer det hemmelige maksimum og byder (fører man
// ikke) det mindst mulige. BidHamr Beskyttelse vælges ikke længere
// (20261031010000): p_beskyttelse sendes stadig, men databasen ignorerer den.
export async function saetMaksimumFor(
  supabase: SupabaseClient,
  brugerId: string,
  ip: string,
  auktionId: unknown,
  maks: unknown,
  beskyttelse: unknown,
  redigeretKl?: unknown,
): Promise<MaksimumOk | BudFejl> {
  if (
    typeof auktionId !== "string" ||
    typeof maks !== "number" ||
    !Number.isFinite(maks) ||
    !Number.isInteger(maks) ||
    maks <= 0
  ) {
    return { fejl: "Skriv dit maksimum i hele kroner.", kode: "ugyldig" };
  }
  if (maks > MAKS_BUD) return { fejl: "Dit maksimum kan højst være 25.000 kr.", kode: "BHB05" };
  const version = versionFra(redigeretKl);

  if (!(await tjekGraenser([["bud_bruger", brugerId], ["bud_ip", ip]]))) {
    return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
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
    const f = faellesFejl(error, besked);
    if (f) return f;
    if (besked.includes("maks_for_lavt")) {
      const v = kr(/mindst\s+([\d.]+)\s*kr/);
      return {
        fejl:
          Number.isFinite(v) && v > 0
            ? `Dit maksimum skal være mindst ${v.toLocaleString("da-DK")} kr.`
            : "Dit maksimum er for lavt.",
        kode: "maks_for_lavt",
      };
    }
    if (besked.includes("maks_under_bud")) {
      const v = kr(/med\s+([\d.]+)\s*kr/);
      return {
        fejl:
          Number.isFinite(v) && v > 0
            ? `Du fører med ${v.toLocaleString("da-DK")} kr. Dit maksimum kan ikke være lavere end dit nuværende bud.`
            : "Dit maksimum kan ikke være lavere end dit nuværende bud.",
        kode: "maks_under_bud",
      };
    }
    if (besked.includes("maks_ugyldigt")) return { fejl: "Dit maksimum er ugyldigt.", kode: "maks_ugyldigt" };
    // Nogen bød lige før dig (mindstebuddet steg) - bed om at prøve igen.
    if (besked.includes("minimum_bid")) {
      return { fejl: "En anden har lige budt. Se det nye bud, og prøv igen.", kode: "minimum_bid" };
    }
    if (besked.includes("Kontoen er slettet")) return { fejl: "Du kan ikke byde.", kode: bhKode(error) ?? "afvist" };
    const s = sidsteFejl(error, besked);
    if (s) return s;
    console.error("saetMaksimum fejlede:", error.code, besked);
    await logDriftFejl({ kilde: "action", hvor: "saetMaksimum", fejl: error, brugerId });
    return { fejl: NOGET_GIK_GALT, kode: "fejl" };
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
    const id = auktionId;
    after(() => notificerEgetNyesteBud(id, brugerId));
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
