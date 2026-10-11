import "server-only";

// Sletter ubrugte beta-skærmbilleder: filer i bucket 'beta-fejl-billeder', der
// er ældre end 24 timer og ikke indgår i en beta_fejl (fx en afbrudt
// indsendelse). Listen kommer fra beta_fejl_ubrugte_billeder
// (20261018020000_beta_fejl.sql); selve sletningen sker via Storage-API'et, så
// filen også forsvinder fra lageret. Kaldes af hovedcron'en
// (/api/cron/afslut-auktioner, hvert 5. minut), men kører højst én gang i
// timen. Fejl logges i drift_fejl af kalderen.
import { createAdminClient } from "@/lib/supabase/admin";
import { indenForGraense } from "@/lib/rateLimit";
import { BETA_FEJL_BUCKET } from "@/lib/betaFejl";

const PR_KOERSEL = 100;

export async function koerBetaFejlOprydning(): Promise<{ slettet: number } | null> {
  if (!(await indenForGraense("beta_fejl_oprydning", "alle"))) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("beta_fejl_ubrugte_billeder", { p_graense: PR_KOERSEL });
  if (error) throw new Error(`beta_fejl_ubrugte_billeder: ${error.message}`);
  const stier = ((data ?? []) as unknown[]).filter((s): s is string => typeof s === "string");
  if (stier.length === 0) return { slettet: 0 };
  const { error: sletFejl } = await admin.storage.from(BETA_FEJL_BUCKET).remove(stier);
  if (sletFejl) throw new Error(`Beta-skærmbilleder kunne ikke slettes: ${sletFejl.message}`);
  return { slettet: stier.length };
}
