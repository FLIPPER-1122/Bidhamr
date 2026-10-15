import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";

// Oprydning af billeder, sælgeren har fjernet ved redigering - ÉN kodevej for
// hjemmesiden (redigerAuktion i src/app/actions/auktion.ts) og appen
// (POST /api/auktion/app/fjern-billeder, docs/APP-ENDPOINTS.md).
//
// Sletter billeder, sælgeren har fjernet ved redigering. Kun filer i
// brugerens egen mappe i auktion-billeder, og kun hvis ingen af brugerens
// auktioner (fx en genopsat vare) stadig bruger dem - sammenlignet på
// storage-stien, ikke den præcise URL. Slettes aldrig, mens der er en åben
// DSA-anmeldelse (ny eller videresendt) eller en åben rapport om auktionen:
// billederne kan være bevis. Service role, fordi storage-policyen ikke lader
// brugeren slette - ejeren er tjekket af kalderen (rediger_auktion på
// hjemmesiden, auctions.bruger_id i appens endpoint). Kaster aldrig.
export const BILLEDE_STI = /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,100}\.[a-z0-9]{1,5}$/;
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
// ("<bruger-id>/<fil>.jpg", appen) -> storage-stien. Andet giver null.
function tilSti(v: string): string | null {
  if (v.includes(BILLEDE_MARKOER)) return billedeSti(v);
  return BILLEDE_STI.test(v) ? v : null;
}

// Returnerer antal slettede filer (0 ved fejl - fejlen logges i drift).
export async function sletFjernedeBilleder(brugerId: string, auktionId: string, urls: string[]): Promise<number> {
  try {
    const admin = createAdminClient();
    const kandidater = urls
      .map(tilSti)
      .filter((sti): sti is string => !!sti && BILLEDE_STI.test(sti) && sti.startsWith(`${brugerId.toLowerCase()}/`));
    if (kandidater.length === 0) return 0;

    // Åben sag om auktionen: behold alt.
    const [anm, rap] = await Promise.all([
      admin
        .from("dsa_anmeldelser")
        .select("id")
        .eq("status", "ny")
        .or(`auktion_id.eq.${auktionId},and(indhold_type.eq.auktion,indhold_id.eq.${auktionId})`)
        .limit(1),
      admin
        .from("reports")
        .select("id")
        .eq("auction_id", auktionId)
        .in("status", ["pending", "under_behandling"])
        .limit(1),
    ]);
    if (anm.error || rap.error) throw new Error(anm.error?.message ?? rap.error?.message);
    if ((anm.data?.length ?? 0) > 0 || (rap.data?.length ?? 0) > 0) return 0;

    // Billederne ligger i brugerens egen mappe og kan kun bruges af
    // brugerens egne auktioner (auktion_billeder_gyldige). Både URL'er og
    // rene stier tæller som "i brug".
    const { data: auktioner, error } = await admin
      .from("auctions")
      .select("billeder")
      .eq("bruger_id", brugerId)
      .limit(5000);
    if (error) throw new Error(error.message);
    const iBrug = new Set<string>();
    for (const a of (auktioner ?? []) as { billeder: string[] | null }[]) {
      for (const url of a.billeder ?? []) {
        const sti = typeof url === "string" ? tilSti(url) : null;
        if (sti) iBrug.add(sti);
      }
    }

    const stier = [...new Set(kandidater)].filter((sti) => !iBrug.has(sti));
    if (stier.length === 0) return 0;
    const { error: sletFejl } = await admin.storage.from("auktion-billeder").remove(stier);
    if (sletFejl) throw sletFejl;
    return stier.length;
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "redigerAuktion: slet fjernede billeder", fejl: err });
    return 0;
  }
}
