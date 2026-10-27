import "server-only";

// Henvis en ven på serveren (20261102230000_henvis_en_ven.sql):
//   - knytHenvisning: efter bekræftelsen af e-mailen (bekraeftKode) knyttes
//     koden fra linket til den NYE konto. Databasen afgør reglerne (ny konto,
//     ingen selvhenvisning, kan ikke skiftes). Fejl stopper aldrig
//     oprettelsen.
//   - sikrHenvisningOptjening: databasen kender ikke LANCERET-flaget. Når
//     siden er lanceret (foerLancering() er false), startes optjeningen én
//     gang (henvisning_start_optjening). Før det giver en MitID-verificeret
//     ven 0 point ('foer_lancering'). Kaldes af cron'en og lige før MitID-
//     registreringen.
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { foerLancering } from "@/lib/lancering";
import { renHenvisningskode } from "@/lib/henvisning/kode";

export type KnytSvar = "ok" | "findes" | "ugyldig" | "ukendt" | "selv" | "ikke_ny" | "ikke_privat" | "fejl";

// Funktionen findes ikke (migrationen er ikke kørt endnu).
function manglerMigration(fejl: { code?: string } | null | undefined): boolean {
  return fejl?.code === "PGRST202" || fejl?.code === "42883";
}

// null = ingen kode givet (eller migrationen mangler). Kaster aldrig.
export async function knytHenvisning(brugerId: string, kodeInput: unknown): Promise<KnytSvar | null> {
  if (kodeInput == null || kodeInput === "") return null;
  const kode = renHenvisningskode(kodeInput);
  if (!kode) return "ugyldig";
  try {
    const { data, error } = await createAdminClient().rpc("henvisning_knyt", { p_ven: brugerId, p_kode: kode });
    if (error) {
      if (manglerMigration(error)) return null;
      throw new Error(`henvisning_knyt: ${error.code ?? ""} ${error.message}`);
    }
    return ((data as { kode?: string } | null)?.kode ?? "fejl") as KnytSvar;
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "knytHenvisning", fejl: err, brugerId });
    return "fejl";
  }
}

// Husk i processen, at optjeningen er startet (sættes kun én gang i
// databasen og kan ikke slås fra igen).
let optjeningStartet = false;

// Kaster aldrig.
export async function sikrHenvisningOptjening(): Promise<void> {
  if (optjeningStartet || foerLancering()) return;
  try {
    const { data, error } = await createAdminClient().rpc("henvisning_start_optjening");
    if (error) {
      if (manglerMigration(error)) return;
      throw new Error(`henvisning_start_optjening: ${error.code ?? ""} ${error.message}`);
    }
    if (data) optjeningStartet = true;
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "sikrHenvisningOptjening", fejl: err });
  }
}

// Cron: start optjeningen (efter lancering) og vurdér henvisninger, der
// stadig afventer, selvom vennen er MitID-verificeret (sikkerhedsnet, hvis
// triggeren fejlede). null = migrationen er ikke kørt.
export async function koerHenvisningCron(): Promise<{ vurderet: number; fejl: number } | null> {
  await sikrHenvisningOptjening();
  const { data, error } = await createAdminClient().rpc("henvisning_synk", { p_graense: 200 });
  if (error) {
    if (manglerMigration(error)) return null;
    throw new Error(`henvisning_synk: ${error.code ?? ""} ${error.message}`);
  }
  const r = data as { vurderet?: number; fejl?: number } | null;
  return { vurderet: Number(r?.vurderet ?? 0), fejl: Number(r?.fejl ?? 0) };
}
