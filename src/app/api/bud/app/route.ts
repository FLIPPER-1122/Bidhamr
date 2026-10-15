import type { NextRequest } from "next/server";
import { klientIp, tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  APP_GENERISK,
  APP_IKKE_LOGGET_IND,
  APP_UGYLDIG,
  UUID_RE,
  appBruger,
  appSvar,
  bearerToken,
  fremmedOrigin,
  laesJsonKrop,
} from "@/lib/appApi";
import { afgivBudFor, saetMaksimumFor } from "@/lib/bud/afgivBud";

// Bud fra appen (Expo). Samme kode som hjemmesidens afgivBud/saetMaksimum
// (src/lib/bud/afgivBud.ts): buddet indsættes med brugerens egen session, så
// RLS og alle bud-triggere gælder; samme grænser (bud_bruger, bud_ip); samme
// besked til de overbudte. Dokumentation: docs/APP-ENDPOINTS.md.
//
// POST /api/bud/app
//   Authorization: Bearer <Supabase access token>
//   Content-Type: application/json
//   { auktion_id, beloeb_oere? , maksimum_oere?, beskyttelse?: boolean,
//     idempotens_noegle: uuid, auktion_redigeret_kl?: string }
//   Præcis ét af beloeb_oere (almindeligt bud) og maksimum_oere (automatisk
//   bud). Beløbet er i øre og skal være hele kroner (delelig med 100).
//   200 { ok: true, foerer, hoejeste_oere, forlaenget }
//   400/401/403/409/413/429/500 { fejl, kode } - kode er databasens BH-kode
//   (fx BHU03, BHV01), når den findes, ellers own_auction, samme_bud,
//   minimum_bid, maks_for_lavt ... (som docs/APP-PLAN.md 4.5).
//
// Idempotens: samme idempotens_noegle fra samme bruger giver det samme svar
// igen (dobbelttryk eller genforsøg efter et tabt svar afgiver ikke et nyt
// bud). Nøglen er bundet til auktion, type (bud/maksimum) og beløb - samme
// nøgle med noget andet giver 409 "noegle_brugt". Mens det første kald
// stadig kører, svarer et nyt kald 409 "behandles". Et afvist bud frigiver
// nøglen, så den kan bruges igen.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BEHANDLES = { fejl: "Dit bud bliver behandlet. Vent et øjeblik, og se auktionen igen.", kode: "behandles" };

type Svar = { ok: true; foerer: boolean; hoejeste_oere: number | null; forlaenget: boolean };

function oereTilKroner(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v % 100 !== 0) return null;
  return v / 100;
}

export async function POST(req: NextRequest) {
  if (fremmedOrigin(req)) return appSvar(403, { fejl: "Ugyldig forespørgsel.", kode: "ikke_tilladt" });

  const ip = await klientIp();
  if (!(await tjekGraenser([["bud_app_ip", ip]]))) {
    return appSvar(429, { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" });
  }

  const token = bearerToken(req);
  if (!token) return appSvar(401, APP_IKKE_LOGGET_IND);

  const k = await laesJsonKrop(req, 2048);
  if ("svar" in k) return k.svar;
  const krop = k.krop;

  if (typeof krop.auktion_id !== "string" || !UUID_RE.test(krop.auktion_id)) return appSvar(400, APP_UGYLDIG);
  // Små bogstaver, så nøglen gemmes og sammenlignes ens (Postgres giver uuid'er
  // tilbage med små bogstaver).
  const auktionId = krop.auktion_id.toLowerCase();
  const noegle = krop.idempotens_noegle;
  if (typeof noegle !== "string" || !UUID_RE.test(noegle)) return appSvar(400, APP_UGYLDIG);
  if (krop.beskyttelse !== undefined && typeof krop.beskyttelse !== "boolean") return appSvar(400, APP_UGYLDIG);
  const harBud = krop.beloeb_oere !== undefined && krop.beloeb_oere !== null;
  const harMaks = krop.maksimum_oere !== undefined && krop.maksimum_oere !== null;
  if (harBud === harMaks) return appSvar(400, APP_UGYLDIG);
  const type = harBud ? "bud" : "maksimum";
  const beloebOere = harBud ? krop.beloeb_oere : krop.maksimum_oere;
  const kroner = oereTilKroner(beloebOere);
  if (kroner === null) {
    return appSvar(400, { fejl: harBud ? "Buddet skal være i hele kroner." : "Skriv dit maksimum i hele kroner.", kode: "ugyldig" });
  }

  const login = await appBruger(token);
  if (!login) return appSvar(401, APP_IKKE_LOGGET_IND);
  const { bruger, supabase } = login;

  const admin = createAdminClient();
  const id = noegle.toLowerCase();
  try {
    // Nøglen tages, før buddet afgives (primærnøgle: bruger + nøgle).
    const { error: claimFejl } = await admin
      .from("app_bud_noegler")
      .insert({ bruger_id: bruger.id, noegle: id, auktion_id: auktionId, type, beloeb_oere: beloebOere });
    if (claimFejl) {
      if (claimFejl.code !== "23505") throw new Error(`app_bud_noegler: ${claimFejl.code} ${claimFejl.message}`);
      const { data: tidligere } = await admin
        .from("app_bud_noegler")
        .select("auktion_id, type, beloeb_oere, svar")
        .eq("bruger_id", bruger.id)
        .eq("noegle", id)
        .maybeSingle<{ auktion_id: string; type: string | null; beloeb_oere: number | string | null; svar: Svar | null }>();
      if (!tidligere) return appSvar(409, BEHANDLES);
      // Nøglen er bundet til præcis dette bud: samme auktion, type og beløb.
      if (
        tidligere.auktion_id !== auktionId ||
        tidligere.type !== type ||
        Number(tidligere.beloeb_oere) !== beloebOere
      ) {
        return appSvar(409, { fejl: "Nøglen er brugt til et andet bud. Prøv igen.", kode: "noegle_brugt" });
      }
      return tidligere.svar ? appSvar(200, tidligere.svar) : appSvar(409, BEHANDLES);
    }

    // Brugerens nøgler ældre end et døgn ryddes op (de er kun et værn mod
    // dobbelttryk og genforsøg - ikke handelsdata; buddene står i bids).
    await admin
      .from("app_bud_noegler")
      .delete()
      .eq("bruger_id", bruger.id)
      .lt("oprettet_kl", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    const { data: foer } = await admin
      .from("auctions")
      .select("slutter_kl")
      .eq("id", auktionId)
      .maybeSingle<{ slutter_kl: string | null }>();

    const r = harBud
      ? await afgivBudFor(supabase, bruger.id, ip, auktionId, kroner, krop.beskyttelse, krop.auktion_redigeret_kl)
      : await saetMaksimumFor(supabase, bruger.id, ip, auktionId, kroner, krop.beskyttelse, krop.auktion_redigeret_kl);

    if ("fejl" in r) {
      // Afvist: nøglen frigives, så et nyt forsøg kan bruge den.
      await admin.from("app_bud_noegler").delete().eq("bruger_id", bruger.id).eq("noegle", id).is("svar", null);
      const status = r.kode === "ugyldig" ? 400 : r.kode === "for_mange" ? 429 : r.kode === "fejl" ? 500 : 409;
      return appSvar(status, { fejl: r.fejl, kode: r.kode });
    }

    const foerMs = foer?.slutter_kl ? Date.parse(foer.slutter_kl) : NaN;
    const efterMs = r.slutterKl ? Date.parse(r.slutterKl) : NaN;
    const svar: Svar = {
      ok: true,
      foerer: r.foerer === true,
      hoejeste_oere: r.nuvaerendeBud !== null ? Math.round(r.nuvaerendeBud * 100) : null,
      forlaenget: Number.isFinite(foerMs) && Number.isFinite(efterMs) && efterMs > foerMs,
    };
    const { error: gemFejl } = await admin
      .from("app_bud_noegler")
      .update({ svar })
      .eq("bruger_id", bruger.id)
      .eq("noegle", id);
    if (gemFejl) await logDriftFejl({ kilde: "server", sti: "/api/bud/app", fejl: gemFejl, brugerId: bruger.id });
    return appSvar(200, svar);
  } catch (err) {
    await logDriftFejl({ kilde: "server", sti: "/api/bud/app", fejl: err, brugerId: bruger.id });
    // Buddet kan være afgivet, før fejlen opstod - nøglen beholdes derfor
    // (et genforsøg med samme nøgle svarer "behandles", ikke et nyt bud).
    return appSvar(500, { fejl: APP_GENERISK, kode: "fejl" });
  }
}
