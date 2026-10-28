import "server-only";

// Køberens "Meld et problem" og sælgerens svar - fælles for hjemmesidens
// server actions (src/app/actions/sager.ts) og appens endpoint
// (src/app/api/sag/app/[handling]/route.ts), så beskederne sendes ens og med
// det samme (også når sagen oprettes fra appen).
//
// supabase: klienten SOM brugeren (cookie-session eller Bearer-token), så
// RPC'erne kører med auth.uid() og databasens regler gælder. brugerId er den
// verificerede bruger (kun til log). Kaster aldrig ved forventede fejl; svar
// { fejl (dansk), kode }.
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logDriftFejl } from "@/lib/drift";
import { notificerSagOprettet, notificerSagSvar } from "@/lib/sagerServer";
import {
  SAG_BESKRIVELSE_MAKS,
  SAG_BESKRIVELSE_MIN,
  SAG_MAKS_BILLEDER,
  SAG_OPRET_FEJL,
  SAG_SMIDT_UD_BEGRUNDELSE_MAKS,
  SAG_SMIDT_UD_BEGRUNDELSE_MIN,
  SAG_SVAR_FEJL,
  SAG_SVAR_MAKS,
  SAG_SVAR_MAKS_BILLEDER,
  SAG_SVAR_MIN,
  type SagBilledeKategori,
  erSagBilledeKategori,
  erSagType,
} from "@/lib/sager";
import { erSagValgId } from "@/lib/tekster/sagValg";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SagBilledeInput = { sti: string; kategori: SagBilledeKategori };
export type SagHandlingFejl = { fejl: string; kode: string };

function kald(opgave: () => Promise<unknown>) {
  const p = () => opgave().catch((err) => console.error("Sagsbesked fejlede:", err));
  try {
    after(p);
  } catch {
    void p();
  }
}

export function rensSagBilleder(billeder: unknown, maks = SAG_MAKS_BILLEDER): SagBilledeInput[] | null {
  if (!Array.isArray(billeder) || billeder.length > maks) return null;
  const ud: SagBilledeInput[] = [];
  for (const b of billeder) {
    if (!b || typeof b !== "object") return null;
    const { sti, kategori } = b as Record<string, unknown>;
    if (typeof sti !== "string" || sti.length > 200 || !erSagBilledeKategori(kategori)) return null;
    ud.push({ sti, kategori });
  }
  return ud;
}

// Køberen opretter en sag. type: sagstypen (fra sagValg.ts - valget). smidtUd
// (regel 2): køberen har ikke pakken længere - forklaring på 20-2000 tegn.
export async function opretSagFor(
  supabase: SupabaseClient,
  brugerId: string,
  input: {
    tradeId: unknown;
    type: unknown;
    beskrivelse: unknown;
    billeder: unknown;
    pakkeSmidtUd?: unknown;
    smidtUdBegrundelse?: unknown;
    // Køberens valg i trin 1 (sagValg.ts, fx "tom"). Valgfrit - uden valg
    // gælder de almindelige billedkrav for typen (20261102350000).
    valg?: unknown;
  },
): Promise<{ ok: true; sagId: string } | SagHandlingFejl> {
  const { tradeId, type, beskrivelse } = input;
  if (typeof tradeId !== "string" || !UUID.test(tradeId)) return { fejl: SAG_OPRET_FEJL.ikke_fundet, kode: "ikke_fundet" };
  if (!erSagType(type)) return { fejl: SAG_OPRET_FEJL.ugyldig_type, kode: "ugyldig_type" };
  const tekst = typeof beskrivelse === "string" ? beskrivelse.trim() : "";
  if (tekst.length < SAG_BESKRIVELSE_MIN || tekst.length > SAG_BESKRIVELSE_MAKS) {
    return { fejl: SAG_OPRET_FEJL.ugyldig_beskrivelse, kode: "ugyldig_beskrivelse" };
  }
  const smidt = input.pakkeSmidtUd === true;
  const grund = smidt && typeof input.smidtUdBegrundelse === "string" ? input.smidtUdBegrundelse.trim() : "";
  if (smidt && (grund.length < SAG_SMIDT_UD_BEGRUNDELSE_MIN || grund.length > SAG_SMIDT_UD_BEGRUNDELSE_MAKS)) {
    return { fejl: SAG_OPRET_FEJL.smidt_ud_begrundelse, kode: "smidt_ud_begrundelse" };
  }
  const rene = rensSagBilleder(input.billeder ?? []);
  if (!rene) return { fejl: SAG_OPRET_FEJL.ugyldige_billeder, kode: "ugyldige_billeder" };
  if (input.valg !== undefined && input.valg !== null && !erSagValgId(input.valg)) {
    return { fejl: SAG_OPRET_FEJL.ugyldigt_valg, kode: "ugyldigt_valg" };
  }
  const valg = erSagValgId(input.valg) ? input.valg : null;

  const { data, error } = await supabase.rpc("sag_opret", {
    p_trade: tradeId,
    p_type: type,
    p_beskrivelse: tekst,
    p_billeder: rene,
    // Kun med, når køberen har valgt det (så en database uden 20261102210000
    // stadig kan kaldes med de 4 parametre).
    ...(smidt ? { p_pakke_smidt_ud: true, p_smidt_ud_begrundelse: grund } : {}),
    // Kun med, når klienten sender valget (20261102350000).
    ...(valg ? { p_valg: valg } : {}),
  });
  if (error) {
    console.error("sag_opret fejlede:", error);
    await logDriftFejl({ kilde: "action", sti: "sager", hvor: "sag_opret", fejl: error, brugerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
  const svar = data as { kode: string; sag_id?: string } | null;
  if (!svar || svar.kode !== "ok" || !svar.sag_id) {
    const kode = svar?.kode ?? "fejl";
    return { fejl: SAG_OPRET_FEJL[kode] ?? GENERISK, kode };
  }
  const sagId = svar.sag_id;
  // Beskeder til køber og sælger med det samme (påkrævet type 'sag'). Kaster
  // aldrig; cron samler op, hvis det fejler (sager.notificeret_kl).
  kald(() => notificerSagOprettet(sagId));
  return { ok: true, sagId };
}

// Sælgeren svarer på en sag (regel 3): tekst og billeder, én gang, inden for
// 48 timer fra oprettelsen. billeder: stier fra upload til 'sag-billeder' i
// sælgerens egen mappe (<sælger-id>/<handel-id>/...).
export async function svarPaaSagFor(
  supabase: SupabaseClient,
  brugerId: string,
  input: { sagId: unknown; tekst: unknown; billeder: unknown },
): Promise<{ ok: true } | SagHandlingFejl> {
  const { sagId } = input;
  if (typeof sagId !== "string" || !UUID.test(sagId)) return { fejl: SAG_SVAR_FEJL.ikke_fundet, kode: "ikke_fundet" };
  const tekst = typeof input.tekst === "string" ? input.tekst.trim() : "";
  if (tekst.length < SAG_SVAR_MIN || tekst.length > SAG_SVAR_MAKS) {
    return { fejl: SAG_SVAR_FEJL.ugyldig_tekst, kode: "ugyldig_tekst" };
  }
  const rene = rensSagBilleder(input.billeder ?? [], SAG_SVAR_MAKS_BILLEDER);
  if (!rene) return { fejl: SAG_SVAR_FEJL.ugyldige_billeder, kode: "ugyldige_billeder" };
  const { data, error } = await supabase.rpc("sag_svar_send", { p_sag: sagId, p_tekst: tekst, p_billeder: rene });
  if (error) {
    await logDriftFejl({ kilde: "action", sti: "sager", hvor: "sag_svar_send", fejl: error, brugerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
  const kode = (data as { kode?: string } | null)?.kode ?? "fejl";
  if (kode !== "ok") return { fejl: SAG_SVAR_FEJL[kode] ?? GENERISK, kode };
  kald(() => notificerSagSvar(sagId));
  return { ok: true };
}
