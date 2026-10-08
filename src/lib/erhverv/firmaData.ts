import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { hentBruger } from "@/lib/supabase/bruger";
import { hentFirmaOversigt } from "@/app/actions/erhverv";
import { logDriftFejl } from "@/lib/drift";
import { FIRMA_DASHBOARD, FIRMA_OVERSIGT } from "@/lib/tekster/erhverv";
import type {
  AuktionGruppe,
  FirmaAuktioner,
  FirmaOversigt,
  FirmaSalg,
  FirmaStatistik,
} from "@/lib/erhverv/regler";

// Data til firma-dashboardet (/firma/*). Alle RPC'er tjekker selv i
// databasen, at brugeren er en firmakonto (null ellers), og læser kun
// brugerens egne data. cache(): layoutet og siden deler ét kald pr.
// forespørgsel.

// Layout og sider kalder denne: ikke logget ind -> login, ikke en firmakonto
// -> forsiden. Fejl kastes (fanges af firma/error.tsx).
// En firmakonto UDEN firma-oplysninger (ingen række i firmaer endnu) sendes
// IKKE til forsiden: før lancering sender gaten firmaet tilbage til /firma,
// så det ville give en løkke. Layoutet viser i stedet en enkel side ("ikke
// sat op endnu") uden siden selv (hentFirmaTilstand), og kraevFirma kaster
// en fejl i siden, hvis den alligevel bygges.
const oversigtCached = cache(() => hentFirmaOversigt());

export type FirmaTilstand =
  | { klar: true; bruger: User; oversigt: FirmaOversigt }
  | { klar: false; bruger: User };

export const hentFirmaTilstand = cache(async (sti: string = "/firma"): Promise<FirmaTilstand> => {
  const bruger = await hentBruger();
  if (!bruger) redirect(`/login?redirect=${encodeURIComponent(sti)}`);
  const svar = await oversigtCached();
  if ("fejl" in svar) throw new Error(FIRMA_OVERSIGT.fejlHent);
  if (svar.oversigt) return { klar: true, bruger, oversigt: svar.oversigt };
  // Ingen firma-oplysninger: kun en firmakonto bliver på /firma.
  const supabase = await createClient();
  const { data, error } = await supabase.from("users").select("konto_type").eq("id", bruger.id).maybeSingle();
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: "firma/konto_type", fejl: error, brugerId: bruger.id });
    throw new Error(FIRMA_OVERSIGT.fejlHent);
  }
  if ((data as { konto_type?: string } | null)?.konto_type !== "erhverv") redirect("/");
  return { klar: false, bruger };
});

export async function kraevFirma(sti: string = "/firma"): Promise<{ bruger: User; oversigt: FirmaOversigt }> {
  const t = await hentFirmaTilstand(sti);
  if (!t.klar) throw new Error(FIRMA_DASHBOARD.ikkeSatOp.fuld);
  return { bruger: t.bruger, oversigt: t.oversigt };
}

async function rpc<T>(navn: string, args?: Record<string, unknown>): Promise<T | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(navn, args);
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: `firma/${navn}`, fejl: error });
    throw new Error(FIRMA_OVERSIGT.fejlHent);
  }
  return (data as T | null) ?? null;
}

export const hentFirmaAuktioner = cache((gruppe: AuktionGruppe) =>
  rpc<FirmaAuktioner>("firma_auktioner", { p_gruppe: gruppe }),
);
export const hentFirmaStatistik = cache(() => rpc<FirmaStatistik>("firma_statistik"));
export const hentFirmaSalg = cache(async () => (await rpc<FirmaSalg>("firma_salg")) ?? []);
