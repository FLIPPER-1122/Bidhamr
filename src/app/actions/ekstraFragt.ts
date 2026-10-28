"use server";

// Sælgeren: ekstra fragt ved for lille pakkestørrelse (migration
// 20261029020000_ekstra_fragt.sql). Én action pr. knap:
//   hentMineEkstraFragtRegninger(tradeId?)       -> sælgerens regninger (offentlige felter)
//   hentMinEkstraFragtStatus()                   -> spærret? (fx på "Opret auktion")
//   startEkstraFragtBetalingAction(regningId)    -> client secret til Stripes Payment Element
//   synkEkstraFragtReturAction(paymentIntentId)  -> efter return_url fra betalingen
//   ekstraFragtIndsigelse(regningId, tekst)      -> indsigelse (én gang)
//   ekstraFragtDokumentationLink(regningId)      -> signeret link (10 min) til fragtfirmaets faktura
// Brugeren findes altid ud fra sessionen - aldrig fra klienten. Beløbet
// kommer fra databasen. Appen bruger /api/betaling/app/ekstra-fragt-* og
// RPC'erne direkte (se docs/FRAGT.md).
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { sagSti } from "@/lib/sager";
import {
  gemEkstraFragtIndsigelse,
  signeretDokumentationsLink,
  startEkstraFragtBetaling,
  synkEkstraFragtRetur,
  type EkstraFragtStart,
} from "@/lib/betaling/ekstraFragt";
import { EKSTRA_FRAGT_SAELGER_FEJL, type EkstraFragtStatus } from "@/lib/ekstraFragt/tekster";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IKKE_LOGGET_IND = "Du er ikke logget ind længere. Log ind igen.";
const GENERISK = "Noget gik galt. Prøv igen om lidt.";

export type MinEkstraFragt = {
  id: string;
  trade_id: string;
  forsendelse_id: string;
  titel: string | null;
  transportoer: string | null;
  sporingsnummer: string | null;
  valgt_stoerrelse: string;
  maalt_stoerrelse: string | null;
  maalt_vaegt_gram: number | null;
  maalt_maal: string | null;
  beloeb_oere: number;
  // null ved en regning for returfragt i en sag (ingen faktura fra fragtfirmaet).
  fragtfirma_fakturanummer: string | null;
  forklaring: string | null;
  har_dokumentation: boolean;
  status: EkstraFragtStatus;
  frist: string;
  spaerrer: boolean;
  kan_betale: boolean;
  kan_goere_indsigelse: boolean;
  indsigelse_tekst: string | null;
  indsigelse_kl: string | null;
  afgoerelse: "frafaldet" | "fastholdt" | null;
  afgoerelse_begrundelse: string | null;
  afgjort_kl: string | null;
  frafald_grund: string | null;
  frafaldet_kl: string | null;
  betalt_kl: string | null;
  refunderet_kl: string | null;
  oprettet_kl: string;
  // Regningen er åbnet igen, fordi betalingen er tilbageført efter en bankindsigelse.
  genaabnet_kl: string | null;
  genaabn_begrundelse: string | null;
};

export type MinEkstraFragtStatus = {
  spaerret: boolean;
  ubetalte: number;
  ubetalt_oere: number;
  indsigelser: number;
  naeste_frist: string | null;
};

async function indloggetBrugerId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  return user?.id ?? null;
}

// Sælgerens regninger (alle, eller kun på én handel). null = kunne ikke hentes.
export async function hentMineEkstraFragtRegninger(tradeId?: string): Promise<MinEkstraFragt[] | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(
      "mine_ekstra_fragt_regninger",
      tradeId && UUID.test(tradeId) ? { p_trade: tradeId } : {},
    );
    if (error) {
      console.error("mine_ekstra_fragt_regninger:", error.message);
      return null;
    }
    return (Array.isArray(data) ? data : []) as MinEkstraFragt[];
  } catch (err) {
    unstable_rethrow(err);
    console.error("hentMineEkstraFragtRegninger fejlede:", err);
    return null;
  }
}

export async function hentMinEkstraFragtStatus(): Promise<MinEkstraFragtStatus | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("min_ekstra_fragt_status");
    if (error) return null;
    return data as MinEkstraFragtStatus;
  } catch (err) {
    unstable_rethrow(err);
    return null;
  }
}

// "Betal" - start (eller genoptag) betalingen. Svar: client secret til
// Stripes Payment Element (card, MobilePay, Revolut Pay - som returfragt).
export async function startEkstraFragtBetalingAction(regningId: string): Promise<EkstraFragtStart> {
  const brugerId = await indloggetBrugerId();
  if (!brugerId) return { fejl: IKKE_LOGGET_IND, kode: "ikke_fundet" };
  if (!(await tjekGraenser([["ekstra_fragt_bruger", brugerId]]))) return { fejl: FOR_MANGE_FORSOEG, kode: "fejl" };
  return startEkstraFragtBetaling(regningId, brugerId, "web");
}

// Efter betalingen (return_url med ?payment_intent=pi_...): spejl status med
// det samme, så siden viser "Betalt" uden at vente på webhooken.
// Svar: 'betalt' | 'allerede' | 'behandles' | 'afventer' | 'ikke_fundet' | null (fejl - webhooken tager den).
export async function synkEkstraFragtReturAction(paymentIntentId: string, tradeId?: string): Promise<string | null> {
  const brugerId = await indloggetBrugerId();
  if (!brugerId) return null;
  if (!(await tjekGraenser([["ekstra_fragt_bruger", brugerId]]))) return null;
  const kode = await synkEkstraFragtRetur(brugerId, String(paymentIntentId ?? ""));
  if (tradeId && UUID.test(tradeId)) revalidatePath(sagSti(tradeId));
  return kode;
}

// Indsigelse mod fragtfirmaets måling (én gang, kun før fristen - ellers
// kode 'frist_overskredet'). En åben betaling annulleres.
export async function ekstraFragtIndsigelse(
  regningId: string,
  tekst: string,
  tradeId?: string,
): Promise<{ ok: true } | { fejl: string; kode?: string }> {
  try {
    if (!UUID.test(String(regningId ?? ""))) return { fejl: EKSTRA_FRAGT_SAELGER_FEJL.ikke_fundet };
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: IKKE_LOGGET_IND };
    if (!(await tjekGraenser([["ekstra_fragt_bruger", user.id]]))) return { fejl: FOR_MANGE_FORSOEG };
    const r = await gemEkstraFragtIndsigelse(supabase, regningId, tekst);
    if ("fejl" in r) return { fejl: r.fejl, kode: r.kode };
    if (tradeId && UUID.test(tradeId)) revalidatePath(sagSti(tradeId));
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    console.error("ekstraFragtIndsigelse fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Signeret link (10 min) til fragtfirmaets faktura - kun sælgerens egen regning.
export async function ekstraFragtDokumentationLink(regningId: string): Promise<{ ok: true; url: string } | { fejl: string }> {
  try {
    if (!UUID.test(String(regningId ?? ""))) return { fejl: EKSTRA_FRAGT_SAELGER_FEJL.ikke_fundet };
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: IKKE_LOGGET_IND };
    if (!(await tjekGraenser([["ekstra_fragt_bruger", user.id]]))) return { fejl: FOR_MANGE_FORSOEG };
    const { data, error } = await supabase.rpc("min_ekstra_fragt_dokumentation", { p_id: regningId });
    if (error) return { fejl: GENERISK };
    const svar = (data ?? {}) as { kode?: string; sti?: string; navn?: string | null };
    if (svar.kode !== "ok" || !svar.sti) return { fejl: EKSTRA_FRAGT_SAELGER_FEJL.ikke_fundet };
    const url = await signeretDokumentationsLink(svar.sti, svar.navn);
    return url ? { ok: true, url } : { fejl: "Fakturaen kunne ikke hentes lige nu. Prøv igen om lidt." };
  } catch (err) {
    unstable_rethrow(err);
    console.error("ekstraFragtDokumentationLink fejlede:", err);
    return { fejl: GENERISK };
  }
}
