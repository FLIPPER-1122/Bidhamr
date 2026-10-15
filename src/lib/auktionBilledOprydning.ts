import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";

// Oprydning af billeder, sælgeren har fjernet ved redigering - ÉN kodevej for
// hjemmesiden (redigerAuktion i src/app/actions/auktion.ts) og appen
// (POST /api/auktion/app/fjern-billeder, docs/APP-ENDPOINTS.md).
//
// Hvad der må slettes, afgør databasen (auktion_billeder_sletbare,
// 20261025010000_app_endpoints.sql), i SQL for præcis de stier, der skal
// slettes:
//   - kun filer i brugerens egen mappe i auktion-billeder,
//   - kun filer, som INGEN af brugerens auktioner bruger (fx en genopsat
//     vare) - som offentlig URL eller ren sti,
//   - intet, mens brugeren har en åben sag (app_bruger_har_aaben_sag): en
//     DSA-anmeldelse, der ikke er afgjort (også når den er videresendt), en
//     åben rapport eller DSA-klage, eller en afgørelse, hvor klagefristen
//     stadig løber - om NOGEN af brugerens auktioner eller brugeren selv.
//     Billederne kan være bevis. Samme regel låser sletning direkte i
//     Storage (auktion_billede_laast).
// Service role, fordi storage-policyen ikke lader brugeren slette - ejeren
// er tjekket af kalderen (rediger_auktion på hjemmesiden, auctions.bruger_id
// i appens endpoint). Kaster aldrig.

const BILLEDE_MARKOER = "/storage/v1/object/public/auktion-billeder/";

export function billedeSti(url: string): string | null {
  const i = url.indexOf(BILLEDE_MARKOER);
  if (i < 0) return null;
  try {
    return decodeURIComponent(url.slice(i + BILLEDE_MARKOER.length).split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
}

// En offentlig URL (hjemmesiden) eller en ren storage-sti
// ("<bruger-id>/<fil>.jpg", appen) -> storage-stien. Databasen tjekker
// formatet og mappen igen.
function tilSti(v: string): string | null {
  return v.includes(BILLEDE_MARKOER) ? billedeSti(v) : v;
}

export type OprydningSvar = { kode: "ok"; slettet: number } | { kode: "sag_aaben" } | { kode: "fejl" };

export async function sletFjernedeBilleder(
  brugerId: string,
  urls: string[],
): Promise<OprydningSvar> {
  try {
    const kandidater = [...new Set(urls.map(tilSti).filter((s): s is string => !!s))];
    if (kandidater.length === 0) return { kode: "ok", slettet: 0 };

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("auktion_billeder_sletbare", {
      p_bruger: brugerId,
      p_stier: kandidater,
    });
    if (error) throw new Error(`auktion_billeder_sletbare: ${error.message}`);
    const svar = (data ?? {}) as { kode?: string; stier?: unknown };
    if (svar.kode === "sag_aaben") return { kode: "sag_aaben" };
    if (svar.kode !== "ok" || !Array.isArray(svar.stier)) throw new Error(`auktion_billeder_sletbare: ${svar.kode}`);
    const stier = svar.stier.filter((s): s is string => typeof s === "string");
    if (stier.length === 0) return { kode: "ok", slettet: 0 };

    const { error: sletFejl } = await admin.storage.from("auktion-billeder").remove(stier);
    if (sletFejl) throw sletFejl;
    return { kode: "ok", slettet: stier.length };
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "redigerAuktion: slet fjernede billeder", fejl: err });
    return { kode: "fejl" };
  }
}
