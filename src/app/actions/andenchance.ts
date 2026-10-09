"use server";

import { erMitIdFejl } from "@/lib/mitid/fejl";
import { MITID } from "@/lib/tekster/mitid";

// Vinderen betaler ikke (ROADMAP-BESLUTNINGER.md, 2. oktober 2026).
// Sælgeren vælger selv næste skridt: tilbyd varen til næste byder, eller sæt
// den op igen gratis.
//
// Brugeren udledes altid af sessionen (auth.getUser) her på serveren og
// sendes som parameter til databasefunktionerne, som kun service-role må
// kalde. Alle funktioner returnerer { ok: true, ... } eller { fejl: string }.

import { revalidatePath } from "next/cache";
import { udbetalingskontoFejltekst } from "@/lib/betaling/frossetServer";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { beskyttelseOere, fragtOere, KOEBERGEBYR_PROCENT } from "@/lib/betaling/beregn";
import { sendSaelgerSvarMail, sendTilbudMail } from "@/lib/betaling/ubetalt";
import {
  erGyldigVarighed,
  slutterKlFraVarighed,
  valideStartpris,
  STARTPRIS_FOR_LAV,
} from "@/lib/auktionRegler";

type Fejl = { fejl: string; mitid?: true };
const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function indloggetBrugerId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  return user?.id ?? null;
}

export type AndenchanceTilbudStatus =
  | "afventer"
  | "accepteret"
  | "afvist"
  | "udloebet"
  | "annulleret";

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

export async function hentAndenchanceStatus(tradeId: string): Promise<AndenchanceStatus | Fejl> {
  try {
    if (!UUID.test(tradeId)) return { fejl: "Handlen findes ikke." };
    const uid = await indloggetBrugerId();
    if (!uid) return { fejl: "Du skal være logget ind." };

    const admin = createAdminClient();
    const { data: handel } = await admin
      .from("trades")
      .select("id, auction_id, seller_id, status")
      .eq("id", tradeId)
      .maybeSingle();
    if (!handel || handel.seller_id !== uid) return { fejl: "Handlen findes ikke." };
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
      ubetalt && !nyHandelId && !genopsatAuktionId
        ? await findesFlereBydere(admin, auktionId, uid)
        : false;

    const aaben = ubetalt && !nyHandelId && !genopsatAuktionId && !ventende;

    // Samme udvælgelse som andenchance_opret (delt SQL i andenchance_naeste_bud).
    let naesteBudOere: number | null = null;
    if (aaben && harFlereBydere) {
      const { data: naeste, error: naesteFejl } = await admin.rpc("andenchance_naeste_bud", {
        p_trade: tradeId,
      });
      if (naesteFejl) console.error("andenchance_naeste_bud fejlede:", naesteFejl);
      else if (naeste !== null && naeste !== undefined) naesteBudOere = Number(naeste);
    }

    return {
      ok: true,
      ubetalt,
      aarsag: sag ? ((sag.aarsag as "ubetalt" | "admin_annulleret" | null) ?? "ubetalt") : null,
      nyHandelId,
      genopsatAuktionId,
      aktivtTilbud: ventende
        ? { id: ventende.id, budOere: ventende.budOere, udloeber: ventende.udloeber }
        : null,
      tilbud: alle,
      harFlereBydere,
      naesteBudOere,
      kanTilbyde: aaben && harFlereBydere,
      kanGenopsaette:
        aaben && auktion?.status === "afsluttet" && auktion?.skjult === false,
    };
  } catch (err) {
    console.error("hentAndenchanceStatus fejlede:", err);
    return { fejl: GENERISK };
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
  const kandidater = [
    ...new Set((bud ?? []).map((b) => b.bruger_id as string).filter((id) => !udelukket.has(id))),
  ];
  if (kandidater.length === 0) return false;

  const { data: brugere } = await admin
    .from("users")
    .select("id, suspenderet, suspenderet_til")
    .in("id", kandidater);
  const nu = Date.now();
  return (brugere ?? []).some(
    (u) =>
      !(
        u.suspenderet &&
        (u.suspenderet_til === null || new Date(u.suspenderet_til as string).getTime() > nu)
      ),
  );
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

export async function sendAndenchanceTilbud(
  tradeId: string,
): Promise<{ ok: true; tilbudId: string; budOere: number; udloeber: string } | Fejl> {
  try {
    if (!UUID.test(tradeId)) return { fejl: OPRET_FEJL.ikke_fundet };
    const uid = await indloggetBrugerId();
    if (!uid) return { fejl: "Du skal være logget ind." };

    const { data, error } = await createAdminClient().rpc("andenchance_opret", {
      p_trade: tradeId,
      p_seller: uid,
    });
    if (error) {
      // MitID mangler (BHV01, a0_andenchance_mitid).
      if (erMitIdFejl(error.code, error.message)) return { fejl: MITID.fejlMangler, mitid: true };
      // To samtidige klik: det partielle unikke index afviser det andet.
      if (error.code === "23505") return { fejl: OPRET_FEJL.aktivt_tilbud };
      console.error("andenchance_opret fejlede:", error);
      return { fejl: GENERISK };
    }
    const r = data as { kode: string; tilbud_id?: string; bud_oere?: number; udloeber?: string };
    if (r.kode !== "ok" || !r.tilbud_id) return { fejl: OPRET_FEJL[r.kode] ?? GENERISK };

    // Mailen claimes; cron sender den, hvis det fejler her.
    try {
      await sendTilbudMail(r.tilbud_id);
    } catch (err) {
      console.error("Tilbudsmail fejlede (cron prøver igen):", err);
    }

    revalidatePath(`/mine-handler/${tradeId}`);
    return {
      ok: true,
      tilbudId: r.tilbud_id,
      budOere: Number(r.bud_oere),
      udloeber: String(r.udloeber),
    };
  } catch (err) {
    console.error("sendAndenchanceTilbud fejlede:", err);
    return { fejl: GENERISK };
  }
}

// ------------------------------------------------------------------ byder: se og svar

export type MitTilbud = {
  ok: true;
  tilbud: {
    id: string;
    status: AndenchanceTilbudStatus;
    udloeber: string;
    besvaretKl: string | null;
    auktionId: string;
    titel: string;
    billede: string | null;
    budOere: number;
    koebergebyrOere: number;
    fragtOere: number;
    beskyttelse: boolean;
    beskyttelseOere: number;
    totalOere: number;
    // Sat, når byderen har sagt ja: handlen, der skal betales.
    nyTradeId: string | null;
    // Kun ved status 'annulleret': solgt til en anden, eller sat op igen.
    annulleretAarsag: "solgt" | "genopsat" | null;
  };
};

export async function hentMitTilbud(tilbudId: string): Promise<MitTilbud | Fejl> {
  try {
    if (!UUID.test(tilbudId)) return { fejl: "Tilbuddet findes ikke." };
    const uid = await indloggetBrugerId();
    if (!uid) return { fejl: "Du skal være logget ind." };

    // RLS lader kun byderen selv læse rækken; byderen filtreres også eksplicit.
    const supabase = await createClient();
    const { data: t } = await supabase
      .from("andenchance_tilbud")
      .select("id, auction_id, byder_id, bud_oere, beskyttelse, status, udloeber, besvaret_kl, ny_trade_id")
      .eq("id", tilbudId)
      .eq("byder_id", uid)
      .maybeSingle();
    if (!t) return { fejl: "Tilbuddet findes ikke." };

    // Byderen har adgang via tilbuddet, også hvis auktionen senere er skjult.
    const { data: a } = await createAdminClient()
      .from("auctions")
      .select("titel, billeder, forsendelse_mulig, fragt_pakkeshop_oere")
      .eq("id", t.auction_id)
      .maybeSingle();

    const bud = Number(t.bud_oere);
    const koeb = Math.round((bud * KOEBERGEBYR_PROCENT) / 100);
    const fragt = fragtOere(Boolean(a?.forsendelse_mulig), a?.fragt_pakkeshop_oere as number | null | undefined);
    const besk = t.beskyttelse ? beskyttelseOere(bud) : 0;
    // Tilbuddet er udløbet, selv om cron endnu ikke har markeret det.
    const status: AndenchanceTilbudStatus =
      t.status === "afventer" && new Date(t.udloeber as string).getTime() <= Date.now()
        ? "udloebet"
        : (t.status as AndenchanceTilbudStatus);

    let annulleretAarsag: "solgt" | "genopsat" | null = null;
    if (status === "annulleret") {
      const admin = createAdminClient();
      const [{ data: aktivHandel }, { data: genopsat }] = await Promise.all([
        admin
          .from("trades")
          .select("id")
          .eq("auction_id", t.auction_id)
          .neq("status", "annulleret")
          .limit(1)
          .maybeSingle(),
        admin
          .from("genopsaetninger")
          .select("ny_auction_id")
          .eq("gammel_auction_id", t.auction_id)
          .maybeSingle(),
      ]);
      if (aktivHandel) annulleretAarsag = "solgt";
      else if (genopsat) annulleretAarsag = "genopsat";
    }

    return {
      ok: true,
      tilbud: {
        id: t.id as string,
        status,
        udloeber: t.udloeber as string,
        besvaretKl: (t.besvaret_kl as string | null) ?? null,
        auktionId: t.auction_id as string,
        titel: (a?.titel as string | undefined) ?? "",
        billede: ((a?.billeder as string[] | undefined) ?? [])[0] ?? null,
        budOere: bud,
        koebergebyrOere: koeb,
        fragtOere: fragt,
        beskyttelse: Boolean(t.beskyttelse),
        beskyttelseOere: besk,
        totalOere: bud + koeb + fragt + besk,
        nyTradeId: (t.ny_trade_id as string | null) ?? null,
        annulleretAarsag,
      },
    };
  } catch (err) {
    console.error("hentMitTilbud fejlede:", err);
    return { fejl: GENERISK };
  }
}

const SVAR_FEJL: Record<string, string> = {
  ikke_fundet: "Tilbuddet findes ikke.",
  ikke_byder: "Tilbuddet findes ikke.",
  besvaret: "Tilbuddet er allerede besvaret.",
  udloebet: "Tilbuddet er udløbet.",
  solgt: "Varen er allerede solgt.",
  genopsat: "Sælgeren har trukket tilbuddet tilbage.",
  suspenderet: "Din konto er suspenderet, og du kan ikke købe.",
};

export async function svarAndenchance(
  tilbudId: string,
  ja: boolean,
): Promise<{ ok: true; tradeId: string | null } | Fejl> {
  try {
    if (!UUID.test(tilbudId) || typeof ja !== "boolean") return { fejl: SVAR_FEJL.ikke_fundet };
    const uid = await indloggetBrugerId();
    if (!uid) return { fejl: "Du skal være logget ind." };

    const { data, error } = await createAdminClient().rpc("andenchance_svar", {
      p_tilbud: tilbudId,
      p_byder: uid,
      p_ja: ja,
    });
    if (error) {
      if (error.code === "23505") return { fejl: SVAR_FEJL.solgt };
      console.error("andenchance_svar fejlede:", error);
      return { fejl: GENERISK };
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
    if (r.kode !== "ok") return { fejl: SVAR_FEJL[r.kode] ?? GENERISK };

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
    return { fejl: GENERISK };
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

export async function genopsaetAuktion(
  auctionId: string,
  startpris: number,
  varighed: number,
): Promise<{ ok: true; auktionId: string } | Fejl> {
  try {
    if (!UUID.test(auctionId)) return { fejl: GENOPSAET_FEJL.ikke_fundet };
    const prisFejl = valideStartpris(startpris);
    if (prisFejl) return { fejl: prisFejl };
    if (!erGyldigVarighed(varighed)) return { fejl: "Vælg en gyldig varighed." };

    const uid = await indloggetBrugerId();
    if (!uid) return { fejl: "Du skal være logget ind." };

    const { data, error } = await createAdminClient().rpc("genopsaet_auktion", {
      p_auction: auctionId,
      p_seller: uid,
      p_startpris: startpris,
      p_slutter_kl: slutterKlFraVarighed(varighed).toISOString(),
    });
    if (error) {
      // MitID mangler (BHV01, auctions_a0_mitid).
      if (erMitIdFejl(error.code, error.message)) return { fejl: MITID.fejlMangler, mitid: true };
      if (error.code === "23505") return { fejl: GENOPSAET_FEJL.allerede_genopsat };
      console.error("genopsaet_auktion fejlede:", error);
      return { fejl: GENERISK };
    }
    const r = data as { kode: string; auction_id?: string };
    if (r.kode === "mangler_udbetalingskonto") {
      return { fejl: await udbetalingskontoFejltekst(uid, GENOPSAET_FEJL.mangler_udbetalingskonto) };
    }
    if (r.kode !== "ok" || !r.auction_id) return { fejl: GENOPSAET_FEJL[r.kode] ?? GENERISK };

    revalidatePath("/");
    revalidatePath(`/auktion/${auctionId}`);
    return { ok: true, auktionId: r.auction_id };
  } catch (err) {
    console.error("genopsaetAuktion fejlede:", err);
    return { fejl: GENERISK };
  }
}
