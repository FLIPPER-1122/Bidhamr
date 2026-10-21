import "server-only";

import { cache } from "react";
import { hentAntalUbetalte } from "@/app/actions/adminActions";
import { hentAntalBetalingerTilHandling } from "@/app/actions/adminBetalinger";
import { antalUbesvaredeStaffSamtaler } from "@/app/actions/staffChat";
import { hentAntalAabneSager } from "@/app/actions/adminSager";
import { hentAntalKontoLukninger } from "@/app/actions/adminKontoLukning";
import { hentAntalTryghed } from "@/app/actions/adminTryghed";
import { hentAntalDsa } from "@/app/actions/adminDsa";
import { hentAntalNyeErhvervHenvendelser } from "@/app/actions/adminErhverv";
import { hentNoedstopBjaelke } from "@/app/actions/adminPengesikkerhed";
import { getStaffRole } from "@/lib/adminAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { hentReklamationTal } from "@/lib/reklamation/tal";
import { createClient } from "@/lib/supabase/server";

// Menuens tællere (kun antal - ingen beløb). cache() deler svaret mellem
// admin/layout.tsx og siden i samme forespørgsel, så forsiden ikke spørger
// databasen om de samme tal igen. Hver tæller tjekker selv rollen
// (assertRole/getStaffRole) og giver 0 uden adgang. En fejl i én tæller
// giver 0 - den vælter ikke admin.
//
// Trin 3 (docs/ADMIN-REDESIGN.md) erstatter kaldene med én admin_status().

export type StaffTal = {
  ubetalte: number;
  betalinger: number;
  chats: number;
  sager: number;
  kontolukninger: number;
  kontakt: number;
  rapporter: number;
  bedoemmelser: number;
  dsa: number;
  dsaOverskredet: number;
  // Handler-fanerne (menuens Handler-tal er summen af dem + ubetalte).
  haenger: number;
  fragt: number;
  markeret: number;
  // Reklamationer hos fragtfirmaet (fragt_reklamationer_antal): venter på
  // sælger (til orientering), stået stille i 14 dage og sagen ændret efter
  // anmeldelsen (begge røde - staff skal se på dem).
  reklamationAfventer: number;
  reklamationStille: number;
  reklamationSagAendret: number;
  // Ekstra fragt (ekstra_fragt_antal): afventer betaling (til orientering),
  // spærrede sælgere (fristen overskredet) og indsigelser (rødt - staff skal
  // afgøre dem).
  ekstraFragtAfventer: number;
  ekstraFragtForfaldne: number;
  ekstraFragtIndsigelser: number;
  // Betalte ekstraregninger, hvor betalingen er tilbageført efter en tabt
  // bankindsigelse (rødt - staff afgør, om regningen skal genåbnes).
  ekstraFragtTabteBankindsigelser: number;
};

function n(r: object | null | undefined, k: string): number {
  if (!r || !(k in r)) return 0;
  const v = Number((r as Record<string, unknown>)[k]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export const hentStaffTal = cache(async (): Promise<StaffTal> => {
  const handler = hentHandlerTal();
  const reklamation = hentReklamationTaellere();
  const ekstraFragt = hentEkstraFragtTal();
  const [ubetalte, betalinger, chats, sager, lukninger, tryghed, dsa] = await Promise.all([
    hentAntalUbetalte(),
    hentAntalBetalingerTilHandling(),
    antalUbesvaredeStaffSamtaler(),
    hentAntalAabneSager(),
    hentAntalKontoLukninger(),
    hentAntalTryghed(),
    hentAntalDsa(),
  ]);
  const [h, r, ef] = await Promise.all([handler, reklamation, ekstraFragt]);
  return {
    ...h,
    ekstraFragtAfventer: n(ef, "afventer_betaling"),
    ekstraFragtForfaldne: n(ef, "forfaldne"),
    ekstraFragtIndsigelser: n(ef, "indsigelser"),
    ekstraFragtTabteBankindsigelser: n(ef, "tabte_bankindsigelser"),
    reklamationAfventer: r?.afventerSaelger ?? 0,
    reklamationStille: r?.stille ?? 0,
    reklamationSagAendret: r?.sagAendret ?? 0,
    ubetalte: n(ubetalte, "antal"),
    betalinger: n(betalinger, "antal"),
    chats: n(chats, "antal"),
    sager: n(sager, "antal"),
    kontolukninger: n(lukninger, "antal"),
    kontakt: n(tryghed, "kontakt"),
    rapporter: n(tryghed, "rapporter"),
    bedoemmelser: n(tryghed, "bedoemmelser"),
    dsa: n(dsa, "antal"),
    dsaOverskredet: n(dsa, "overskredet"),
  };
});

// Tallene på Handler-fanerne: hænger (admin_haengende_handler, samme som
// forsiden), fragt (forsendelser.kraever_opmaerksomhed) og markeret af os
// (trades.sag_aaben). Kun staff (getStaffRole); fejl giver 0.
async function hentHandlerTal(): Promise<{ haenger: number; fragt: number; markeret: number }> {
  if (!(await getStaffRole())) return { haenger: 0, fragt: 0, markeret: 0 };
  const admin = createAdminClient();
  const [haeng, fragt, markeret] = await Promise.all([
    admin.rpc("admin_haengende_handler"),
    admin.from("forsendelser").select("id", { count: "exact", head: true }).eq("kraever_opmaerksomhed", true),
    admin.from("trades").select("id", { count: "exact", head: true }).eq("sag_aaben", true),
  ]);
  return {
    haenger: haeng.error ? 0 : ((haeng.data ?? []) as unknown[]).length,
    fragt: fragt.error ? 0 : (fragt.count ?? 0),
    markeret: markeret.error ? 0 : (markeret.count ?? 0),
  };
}

// Reklamationer hos fragtfirmaet (kun staff; fejl, fx før migrationen, giver null).
async function hentReklamationTaellere() {
  if (!(await getStaffRole())) return null;
  return hentReklamationTal(createAdminClient());
}

// Ekstra fragt (ekstra_fragt_antal). Kaldes med BRUGERENS session: databasen
// tjekker selv er_staff() (rolle + to-trins-login) og giver 0 ellers. Fejl
// (fx før migrationen 20261029020000) giver null = 0.
async function hentEkstraFragtTal(): Promise<object | null> {
  if (!(await getStaffRole())) return null;
  try {
    const { data, error } = await (await createClient()).rpc("ekstra_fragt_antal");
    return error || !data || typeof data !== "object" ? null : (data as object);
  } catch {
    return null;
  }
}

// Nye erhvervshenvendelser (chef og sælger; andre får 0).
export const hentErhvervNye = cache(async (): Promise<number> => n(await hentAntalNyeErhvervHenvendelser(), "antal"));

// Nødstop (sikkerhedsnet A): hvad der er stoppet - for al staff. Årsagen
// sendes kun med for chefen (hentNoedstopBjaelke). Delt mellem layoutets røde
// bjælke og forsidens lampe/statuslinje.
export type NoedstopTal = { udbetalinger: boolean; nyeBetalinger: boolean; aarsag: string | null; stoppet: string | null };

export const hentNoedstopTal = cache(async (): Promise<NoedstopTal> => {
  const n = await hentNoedstopBjaelke();
  if (!("ok" in n)) return { udbetalinger: false, nyeBetalinger: false, aarsag: null, stoppet: null };
  const dele = [n.udbetalinger && "udbetalinger til sælgerne", n.nyeBetalinger && "nye betalinger"].filter(Boolean);
  return { udbetalinger: n.udbetalinger, nyeBetalinger: n.nyeBetalinger, aarsag: n.aarsag, stoppet: dele.length ? dele.join(" og ") : null };
});
