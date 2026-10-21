import "server-only";

// Tilbud til næste byder og "sæt op igen" (ROADMAP-BESLUTNINGER.md, 2.
// oktober 2026) - ÉN kodevej for hjemmesidens server actions
// (src/app/actions/andenchance.ts) og appens endpoint
// (POST /api/handel/app/andenchance-*, genopsaet - docs/APP-ENDPOINTS.md).
//
// uid SKAL være den verificerede, indloggede bruger (cookie-session eller
// Bearer-token valideret med auth.getUser). Den sendes som parameter til
// databasefunktionerne, som kun service-role må kalde.
//
// Fejl RETURNERES som { fejl, kode } - fejl er en dansk tekst, der kan vises.

import { revalidatePath } from "next/cache";
import { erMitIdFejl } from "@/lib/mitid/fejl";
import { erDac7Fejl, DAC7_FEJL_TEKST } from "@/lib/dac7/fejl";
import { erEkstraFragtFejl, EKSTRA_FRAGT_SPAERRET_TEKST } from "@/lib/ekstraFragt/tekster";
import { MITID } from "@/lib/tekster/mitid";
import { erVilkaarFejl } from "@/lib/vilkaar";
import { VILKAAR_TEKST } from "@/lib/tekster/vilkaar";
import { udbetalingskontoFejltekst } from "@/lib/betaling/frossetServer";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendSaelgerSvarMail, sendTilbudMail } from "@/lib/betaling/ubetalt";
import { erGyldigVarighed, slutterKlFraVarighed, valideStartpris, STARTPRIS_FOR_LAV } from "@/lib/auktionRegler";

export type AndenchanceFejl = { fejl: string; kode: string; mitid?: true };
const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AndenchanceTilbudStatus = "afventer" | "accepteret" | "afvist" | "udloebet" | "annulleret";

// ------------------------------------------------------------------ sælger: status

export type AndenchanceStatus = {
  ok: true;
  // Handlen blev annulleret, fordi køberen ikke betalte (eller BidHamr
  // annullerede den, før der var betalt).
  ubetalt: boolean;
  // Hvorfor handlen blev annulleret (null = ingen sag).
  aarsag: "ubetalt" | "admin_annulleret" | null;
  // Der findes en ikke-annulleret handel på auktionen (fx fra et accepteret tilbud).
  nyHandelId: string | null;
  // Auktionen er sat op igen som en ny auktion.
  genopsatAuktionId: string | null;
  // Det ventende tilbud (højst ét).
  aktivtTilbud: { id: string; budOere: number; udloeber: string } | null;
  // Alle tilbud på auktionen, nyeste først. Byderen vises ikke (privatliv).
  tilbud: {
    id: string;
    status: AndenchanceTilbudStatus;
    budOere: number;
    oprettet: string;
    udloeber: string;
    besvaretKl: string | null;
  }[];
  // Der er mindst én byder tilbage, der kan få tilbuddet.
  harFlereBydere: boolean;
  // Beløbet for den byder, andenchance_opret ville vælge nu (uden byder-id).
  naesteBudOere: number | null;
  kanTilbyde: boolean;
  kanGenopsaette: boolean;
};

export async function hentAndenchanceStatusFor(uid: string, tradeId: unknown): Promise<AndenchanceStatus | AndenchanceFejl> {
  try {
    if (typeof tradeId !== "string" || !UUID.test(tradeId)) return { fejl: "Handlen findes ikke.", kode: "ikke_fundet" };

    const admin = createAdminClient();
    const { data: handel } = await admin
      .from("trades")
      .select("id, auction_id, seller_id, status")
      .eq("id", tradeId)
      .maybeSingle();
    if (!handel || handel.seller_id !== uid) return { fejl: "Handlen findes ikke.", kode: "ikke_fundet" };
    const auktionId = handel.auction_id as string;

    const [{ data: sag }, { data: aktiv }, { data: tilbud }, { data: genopsat }, { data: auktion }] =
      await Promise.all([
        admin.from("ubetalte_vindere").select("id, aarsag").eq("trade_id", tradeId).maybeSingle(),
        admin
          .from("trades")
          .select("id")
          .eq("auction_id", auktionId)
          .neq("status", "annulleret")
          .maybeSingle(),
        admin
          .from("andenchance_tilbud")
          .select("id, status, bud_oere, oprettet, udloeber, besvaret_kl")
          .eq("auction_id", auktionId)
          .order("oprettet", { ascending: false }),
        admin
          .from("genopsaetninger")
          .select("ny_auction_id")
          .eq("gammel_auction_id", auktionId)
          .maybeSingle(),
        admin.from("auctions").select("status, skjult").eq("id", auktionId).maybeSingle(),
      ]);

    const alle = (tilbud ?? []).map((t) => ({
      id: t.id as string,
      status: t.status as AndenchanceTilbudStatus,
      budOere: Number(t.bud_oere),
      oprettet: t.oprettet as string,
      udloeber: t.udloeber as string,
      besvaretKl: (t.besvaret_kl as string | null) ?? null,
    }));
    const ventende = alle.find((t) => t.status === "afventer") ?? null;
    const ubetalt = handel.status === "annulleret" && Boolean(sag);
    const nyHandelId = (aktiv?.id as string | undefined) ?? null;
    const genopsatAuktionId = (genopsat?.ny_auction_id as string | undefined) ?? null;

    const harFlereBydere =
      ubetalt && !nyHandelId && !genopsatAuktionId ? await findesFlereBydere(admin, auktionId, uid) : false;

    const aaben = ubetalt && !nyHandelId && !genopsatAuktionId && !ventende;

    // Samme udvælgelse som andenchance_opret (delt SQL i andenchance_naeste_bud).
    let naesteBudOere: number | null = null;
    if (aaben && harFlereBydere) {
      const { data: naeste, error: naesteFejl } = await admin.rpc("andenchance_naeste_bud", { p_trade: tradeId });
      if (naesteFejl) console.error("andenchance_naeste_bud fejlede:", naesteFejl);
      else if (naeste !== null && naeste !== undefined) naesteBudOere = Number(naeste);
    }

    return {
      ok: true,
      ubetalt,
      aarsag: sag ? ((sag.aarsag as "ubetalt" | "admin_annulleret" | null) ?? "ubetalt") : null,
      nyHandelId,
      genopsatAuktionId,
      aktivtTilbud: ventende ? { id: ventende.id, budOere: ventende.budOere, udloeber: ventende.udloeber } : null,
      tilbud: alle,
      harFlereBydere,
      naesteBudOere,
      kanTilbyde: aaben && harFlereBydere,
      kanGenopsaette: aaben && auktion?.status === "afsluttet" && auktion?.skjult === false,
    };
  } catch (err) {
    console.error("hentAndenchanceStatus fejlede:", err);
    return { fejl: GENERISK, kode: "fejl" };
  }
}

// Samme regel som andenchance_opret i databasen. Kun til visning; databasen
// afgør, hvem der rent faktisk får tilbuddet.
async function findesFlereBydere(
  admin: ReturnType<typeof createAdminClient>,
  auktionId: string,
  saelgerId: string,
): Promise<boolean> {
  const [{ data: bud }, { data: koebere }, { data: tilbudte }] = await Promise.all([
    admin.from("bids").select("bruger_id").eq("auktion_id", auktionId).gt("beløb", 0),
    admin.from("trades").select("buyer_id").eq("auction_id", auktionId),
    admin.from("andenchance_tilbud").select("byder_id").eq("auction_id", auktionId),
  ]);
  const udelukket = new Set<string>([
    saelgerId,
    ...(koebere ?? []).map((k) => k.buyer_id as string),
    ...(tilbudte ?? []).map((t) => t.byder_id as string),
  ]);
  const kandidater = [...new Set((bud ?? []).map((b) => b.bruger_id as string).filter((id) => !udelukket.has(id)))];
  if (kandidater.length === 0) return false;

  const { data: brugere } = await admin.from("users").select("id, suspenderet, suspenderet_til").in("id", kandidater);
  const nu = Date.now();
  return (brugere ?? []).some(
    (u) =>
      !(u.suspenderet && (u.suspenderet_til === null || new Date(u.suspenderet_til as string).getTime() > nu)),
  );
}

// Fælles oversættelse af MitID-, vilkårs- og DAC7-fejl fra databasen.
function kravFejl(code: string | undefined, message: string | undefined, medDac7: boolean): AndenchanceFejl | null {
  if (erMitIdFejl(code, message)) return { fejl: MITID.fejlMangler, kode: "mitid", mitid: true };
  if (erVilkaarFejl(code, message)) return { fejl: VILKAAR_TEKST.fejlMangler, kode: "vilkaar" };
  if (medDac7 && erDac7Fejl(code, message)) return { fejl: DAC7_FEJL_TEKST, kode: "dac7" };
  // Ubetalt ekstra fragt efter fristen (BHX01) - samme sted som DAC7.
  if (medDac7 && erEkstraFragtFejl(code, message)) return { fejl: EKSTRA_FRAGT_SPAERRET_TEKST, kode: "ekstra_fragt" };
  return null;
}

// ------------------------------------------------------------------ sælger: send tilbud

const OPRET_FEJL: Record<string, string> = {
  ikke_fundet: "Handlen findes ikke.",
  ikke_saelger: "Handlen findes ikke.",
  ikke_ubetalt: "Du kan kun sende tilbuddet videre, når køberen ikke har betalt.",
  aktivt_tilbud: "Der er allerede et tilbud, der venter på svar.",
  solgt: "Varen er allerede solgt til en anden byder.",
  genopsat: "Varen er sat op igen og kan ikke længere tilbydes.",
  ingen_flere_bydere: "Der er ikke flere bydere at tilbyde varen til.",
};

export async function sendAndenchanceTilbudFor(
  uid: string,
  tradeId: unknown,
): Promise<{ ok: true; tilbudId: string; budOere: number; udloeber: string } | AndenchanceFejl> {
  try {
    if (typeof tradeId !== "string" || !UUID.test(tradeId)) return { fejl: OPRET_FEJL.ikke_fundet, kode: "ikke_fundet" };

    const { data, error } = await createAdminClient().rpc("andenchance_opret", { p_trade: tradeId, p_seller: uid });
    if (error) {
      // MitID (BHV01), brugerbetingelser (BHV02) og DAC7 mangler.
      const krav = kravFejl(error.code, error.message, true);
      if (krav) return krav;
      // To samtidige klik: det partielle unikke index afviser det andet.
      if (error.code === "23505") return { fejl: OPRET_FEJL.aktivt_tilbud, kode: "aktivt_tilbud" };
      console.error("andenchance_opret fejlede:", error);
      return { fejl: GENERISK, kode: "fejl" };
    }
    const r = data as { kode: string; tilbud_id?: string; bud_oere?: number; udloeber?: string };
    if (r.kode !== "ok" || !r.tilbud_id) return { fejl: OPRET_FEJL[r.kode] ?? GENERISK, kode: r.kode ?? "fejl" };

    // Mailen claimes; cron sender den, hvis det fejler her.
    try {
      await sendTilbudMail(r.tilbud_id);
    } catch (err) {
      console.error("Tilbudsmail fejlede (cron prøver igen):", err);
    }

    revalidatePath(`/mine-handler/${tradeId}`);
    return { ok: true, tilbudId: r.tilbud_id, budOere: Number(r.bud_oere), udloeber: String(r.udloeber) };
  } catch (err) {
    console.error("sendAndenchanceTilbud fejlede:", err);
    return { fejl: GENERISK, kode: "fejl" };
  }
}

// ------------------------------------------------------------------ byder: svar

const SVAR_FEJL: Record<string, string> = {
  ikke_fundet: "Tilbuddet findes ikke.",
  ikke_byder: "Tilbuddet findes ikke.",
  besvaret: "Tilbuddet er allerede besvaret.",
  udloebet: "Tilbuddet er udløbet.",
  solgt: "Varen er allerede solgt.",
  genopsat: "Sælgeren har trukket tilbuddet tilbage.",
  suspenderet: "Din konto er suspenderet, og du kan ikke købe.",
};

export async function svarAndenchanceFor(
  uid: string,
  tilbudId: unknown,
  ja: unknown,
): Promise<{ ok: true; tradeId: string | null } | AndenchanceFejl> {
  try {
    if (typeof tilbudId !== "string" || !UUID.test(tilbudId) || typeof ja !== "boolean") {
      return { fejl: SVAR_FEJL.ikke_fundet, kode: "ikke_fundet" };
    }

    const { data, error } = await createAdminClient().rpc("andenchance_svar", {
      p_tilbud: tilbudId,
      p_byder: uid,
      p_ja: ja,
    });
    if (error) {
      if (error.code === "23505") return { fejl: SVAR_FEJL.solgt, kode: "solgt" };
      // Køberen har ikke accepteret brugerbetingelserne (BHV02). Tilbuddet
      // står stadig åbent.
      if (erVilkaarFejl(error.code, error.message)) return { fejl: VILKAAR_TEKST.fejlMangler, kode: "vilkaar" };
      console.error("andenchance_svar fejlede:", error);
      return { fejl: GENERISK, kode: "fejl" };
    }
    const r = data as { kode: string; trade_id?: string };
    if (r.kode === "suspenderet") {
      // Tilbuddet er lukket i databasen; sælgeren får besked og kan gå videre.
      try {
        await sendSaelgerSvarMail(tilbudId, true);
      } catch (err) {
        console.error("Mail til sælger om lukket tilbud fejlede:", err);
      }
      revalidatePath(`/andenchance/${tilbudId}`);
    }
    if (r.kode !== "ok") return { fejl: SVAR_FEJL[r.kode] ?? GENERISK, kode: r.kode ?? "fejl" };

    try {
      await sendSaelgerSvarMail(tilbudId);
    } catch (err) {
      console.error("Svarmail til sælger fejlede (cron prøver igen):", err);
    }

    revalidatePath(`/andenchance/${tilbudId}`);
    if (r.trade_id) revalidatePath(`/mine-handler/${r.trade_id}`);
    return { ok: true, tradeId: r.trade_id ?? null };
  } catch (err) {
    console.error("svarAndenchance fejlede:", err);
    return { fejl: GENERISK, kode: "fejl" };
  }
}

// ------------------------------------------------------------------ sælger: sæt op igen

const GENOPSAET_FEJL: Record<string, string> = {
  ikke_fundet: "Auktionen findes ikke.",
  ikke_saelger: "Auktionen findes ikke.",
  suspenderet: "Din konto er suspenderet, og du kan ikke sætte varer op.",
  ikke_ubetalt: "Kun varer, hvor vinderen ikke betalte, kan sættes op igen her.",
  ikke_afsluttet: "Kun afsluttede auktioner kan sættes op igen.",
  skjult: "Auktionen er fjernet og kan ikke sættes op igen.",
  solgt: "Varen er solgt og kan ikke sættes op igen.",
  allerede_genopsat: "Varen er allerede sat op igen.",
  ugyldig_startpris: "Startprisen er ugyldig.",
  startpris_for_lav: STARTPRIS_FOR_LAV,
  ugyldig_slutdato: "Varigheden er ugyldig.",
  mangler_udbetalingskonto: "Du skal oprette en udbetalingskonto, før du kan sætte varer til salg.",
};

export async function genopsaetAuktionFor(
  uid: string,
  auctionId: unknown,
  startpris: unknown,
  varighed: unknown,
): Promise<{ ok: true; auktionId: string } | AndenchanceFejl> {
  try {
    if (typeof auctionId !== "string" || !UUID.test(auctionId)) {
      return { fejl: GENOPSAET_FEJL.ikke_fundet, kode: "ikke_fundet" };
    }
    if (typeof startpris !== "number") return { fejl: GENOPSAET_FEJL.ugyldig_startpris, kode: "ugyldig_startpris" };
    const prisFejl = valideStartpris(startpris);
    if (prisFejl) return { fejl: prisFejl, kode: "ugyldig_startpris" };
    if (typeof varighed !== "number" || !erGyldigVarighed(varighed)) {
      return { fejl: "Vælg en gyldig varighed.", kode: "ugyldig_varighed" };
    }

    const { data, error } = await createAdminClient().rpc("genopsaet_auktion", {
      p_auction: auctionId,
      p_seller: uid,
      p_startpris: startpris,
      p_slutter_kl: slutterKlFraVarighed(varighed).toISOString(),
    });
    if (error) {
      const krav = kravFejl(error.code, error.message, true);
      if (krav) return krav;
      if (error.code === "23505") return { fejl: GENOPSAET_FEJL.allerede_genopsat, kode: "allerede_genopsat" };
      console.error("genopsaet_auktion fejlede:", error);
      return { fejl: GENERISK, kode: "fejl" };
    }
    const r = data as { kode: string; auction_id?: string };
    if (r.kode === "mangler_udbetalingskonto") {
      return {
        fejl: await udbetalingskontoFejltekst(uid, GENOPSAET_FEJL.mangler_udbetalingskonto),
        kode: "mangler_udbetalingskonto",
      };
    }
    if (r.kode !== "ok" || !r.auction_id) return { fejl: GENOPSAET_FEJL[r.kode] ?? GENERISK, kode: r.kode ?? "fejl" };

    revalidatePath("/");
    revalidatePath(`/auktion/${auctionId}`);
    return { ok: true, auktionId: r.auction_id };
  } catch (err) {
    console.error("genopsaetAuktion fejlede:", err);
    return { fejl: GENERISK, kode: "fejl" };
  }
}
