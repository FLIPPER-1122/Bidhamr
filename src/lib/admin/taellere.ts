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
};

function n(r: object | null | undefined, k: string): number {
  if (!r || !(k in r)) return 0;
  const v = Number((r as Record<string, unknown>)[k]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export const hentStaffTal = cache(async (): Promise<StaffTal> => {
  const [ubetalte, betalinger, chats, sager, lukninger, tryghed, dsa] = await Promise.all([
    hentAntalUbetalte(),
    hentAntalBetalingerTilHandling(),
    antalUbesvaredeStaffSamtaler(),
    hentAntalAabneSager(),
    hentAntalKontoLukninger(),
    hentAntalTryghed(),
    hentAntalDsa(),
  ]);
  return {
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

// Nye erhvervshenvendelser (chef og sælger; andre får 0).
export const hentErhvervNye = cache(async (): Promise<number> => n(await hentAntalNyeErhvervHenvendelser(), "antal"));
