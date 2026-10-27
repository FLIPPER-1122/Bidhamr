import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { sideUrl } from "@/lib/seo";

// Henvis en ven: brugerens eget link og status - samme kald på hjemmesiden
// (/konto/henvis) og i appen (POST /api/konto/henvisning). min_henvisning()
// udleder brugeren af auth.uid() (20261102230000_henvis_en_ven.sql), så
// klienten SKAL kalde som brugeren (cookie-session eller Bearer-token).

export type HenvisningStatus =
  | "afventer"
  | "belonnet"
  | "loft"
  | "firma"
  | "spaerret"
  | "foer_lancering"
  | "samme_person"
  | "tidligere_konto";

export type HenvistVen = {
  navn: string;
  status: HenvisningStatus;
  point: number;
  oprettet_kl: string;
  vurderet_kl: string | null;
};

export type MinHenvisning =
  | { kan_henvise: false; grund: "erhverv" }
  | {
      kan_henvise: true;
      kode: string;
      sti: string;
      // Fuldt link, fx https://bidhamr.dk/?ven=KODE (tilføjet her).
      url: string;
      kan_faa_point: boolean;
      grund: "spaerret" | null;
      optjening_aaben: boolean;
      point_pr_ven: number;
      maks_pr_maaned: number;
      maaned: string;
      belonnet_denne_maaned: number;
      tilbage_denne_maaned: number;
      antal_venner: number;
      antal_afventer: number;
      antal_belonnet: number;
      point_i_alt: number;
      venner: HenvistVen[];
    };

// null = ikke logget ind, migrationen mangler, eller kaldet fejlede.
export async function hentMinHenvisning(supabase: SupabaseClient): Promise<MinHenvisning | null> {
  const { data, error } = await supabase.rpc("min_henvisning");
  if (error) {
    if (error.code !== "PGRST202") console.error("min_henvisning:", error.code, error.message);
    return null;
  }
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return null;
  if (d.kan_henvise !== true) return { kan_henvise: false, grund: "erhverv" };
  const sti = typeof d.sti === "string" ? d.sti : "";
  return { ...(d as Omit<Extract<MinHenvisning, { kan_henvise: true }>, "url">), url: `${sideUrl()}${sti}` };
}
