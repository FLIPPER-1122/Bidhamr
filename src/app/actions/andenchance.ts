"use server";

// Vinderen betaler ikke (ROADMAP-BESLUTNINGER.md, 2. oktober 2026).
// Sælgeren vælger selv næste skridt: tilbyd varen til næste byder, eller sæt
// den op igen gratis.
//
// Brugeren udledes altid af sessionen (auth.getUser) her på serveren. Selve
// logikken deles med appen (src/lib/andenchance.ts). Alle funktioner
// returnerer { ok: true, ... } eller { fejl: string }.

import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { beskyttelseOere, fragtOere, KOEBERGEBYR_PROCENT } from "@/lib/betaling/beregn";
import {
  genopsaetAuktionFor,
  hentAndenchanceStatusFor,
  sendAndenchanceTilbudFor,
  svarAndenchanceFor,
  type AndenchanceFejl,
  type AndenchanceStatus,
  type AndenchanceTilbudStatus,
} from "@/lib/andenchance";

export type { AndenchanceStatus, AndenchanceTilbudStatus };

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

// Hjemmesiden viser kun teksten (og MitID-knappen) - koden er til appen.
function udenKode(f: AndenchanceFejl): Fejl {
  return f.mitid ? { fejl: f.fejl, mitid: true } : { fejl: f.fejl };
}

// ------------------------------------------------------------------ sælger: status

export async function hentAndenchanceStatus(tradeId: string): Promise<AndenchanceStatus | Fejl> {
  if (!UUID.test(tradeId)) return { fejl: "Handlen findes ikke." };
  const uid = await indloggetBrugerId();
  if (!uid) return { fejl: "Du skal være logget ind." };
  const r = await hentAndenchanceStatusFor(uid, tradeId);
  return "fejl" in r ? udenKode(r) : r;
}

// ------------------------------------------------------------------ sælger: send tilbud

export async function sendAndenchanceTilbud(
  tradeId: string,
): Promise<{ ok: true; tilbudId: string; budOere: number; udloeber: string } | Fejl> {
  if (!UUID.test(tradeId)) return { fejl: "Handlen findes ikke." };
  const uid = await indloggetBrugerId();
  if (!uid) return { fejl: "Du skal være logget ind." };
  const r = await sendAndenchanceTilbudFor(uid, tradeId);
  return "fejl" in r ? udenKode(r) : r;
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

export async function svarAndenchance(
  tilbudId: string,
  ja: boolean,
): Promise<{ ok: true; tradeId: string | null } | Fejl> {
  if (!UUID.test(tilbudId) || typeof ja !== "boolean") return { fejl: "Tilbuddet findes ikke." };
  const uid = await indloggetBrugerId();
  if (!uid) return { fejl: "Du skal være logget ind." };
  const r = await svarAndenchanceFor(uid, tilbudId, ja);
  return "fejl" in r ? udenKode(r) : r;
}

// ------------------------------------------------------------------ sælger: sæt op igen

export async function genopsaetAuktion(
  auctionId: string,
  startpris: number,
  varighed: number,
): Promise<{ ok: true; auktionId: string } | Fejl> {
  if (!UUID.test(auctionId)) return { fejl: "Auktionen findes ikke." };
  const uid = await indloggetBrugerId();
  if (!uid) return { fejl: "Du skal være logget ind." };
  const r = await genopsaetAuktionFor(uid, auctionId, startpris, varighed);
  return "fejl" in r ? udenKode(r) : r;
}
