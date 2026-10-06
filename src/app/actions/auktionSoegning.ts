"use server";

// Næste side / nye filtre på /auktioner. Samme forespørgsel som siden selv
// (src/lib/auktionSoegning.ts); alle input valideres dér. Kun offentlige
// auktionsdata, læst med brugerens egen session (RLS).
//
// Handlingen er offentlig (også uden login) og kan kaldes direkte, så den har
// en grænse pr. IP og - for indloggede - pr. bruger (src/lib/rateLimit.ts).

import { hentAuktionsside, type AuktionsFiltre, type AuktionsSide } from "@/lib/auktionSoegning";
import { klientIp, tjekGraenser } from "@/lib/rateLimit";
import { createClient } from "@/lib/supabase/server";

const FOR_HURTIGT = "Du søger lidt for hurtigt – vent et øjeblik.";

async function brugerId(): Promise<string | null> {
  try {
    // getClaims verificerer tokenet (en forfalsket cookie kan ikke bruge en
    // andens grænse op) uden et ekstra kald til Auth, når nøglen er asymmetrisk.
    const { data } = await (await createClient()).auth.getClaims();
    const sub = data?.claims?.sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    return null;
  }
}

export async function soegAuktioner(filtre: AuktionsFiltre): Promise<AuktionsSide> {
  if (!filtre || typeof filtre !== "object") {
    return { ok: false, fejl: "Auktionerne kunne ikke hentes. Prøv igen." };
  }

  const [ip, bruger] = await Promise.all([klientIp(), brugerId()]);
  const graenser: Parameters<typeof tjekGraenser>[0] = [["soeg_ip", ip]];
  if (bruger) graenser.push(["soeg_bruger", bruger]);
  if (!(await tjekGraenser(graenser))) return { ok: false, fejl: FOR_HURTIGT };

  return hentAuktionsside({
    q: filtre.q,
    kategori: filtre.kategori,
    sortering: filtre.sortering,
    postnummer: filtre.postnummer,
    radiusKm: filtre.radiusKm,
    offset: filtre.offset,
  });
}
