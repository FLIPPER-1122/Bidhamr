import "server-only";

// Hvem må se og bruge "Meld fejl"-knappen? Kun før lancering, kun logget ind,
// og kun beta-testere og staff (chef, admin, medarbejder). Firmakonti og
// erhvervssælgere (rollen 'saelger') er ikke med.
//
// Knappen (src/components/betafejl/BetaFejlKnap.tsx) spørger IKKE databasen:
// den bruger sessionens JWT (getClaims, tjekket lokalt) og den signerede
// rolle-cookie, som gaten i src/lib/supabase/middleware.ts allerede har lavet
// eller fornyet i samme forespørgsel (cookies sat i proxyen kan læses med
// cookies() i renderingen). Mangler cookien eller er den ugyldig, vises
// knappen ikke - det er kun visning. Selve indsendelsen
// (src/app/actions/betaFejl.ts) tjekker rollen og beta-adgangen i databasen.
import { cache } from "react";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { foerLancering } from "@/lib/lancering";
import { ROLLE_COOKIE, laesRolleCookie, type GateIdentitet } from "@/lib/rolleCookie";

const STAFF_ROLLER = ["chef", "admin", "medarbejder"];

export function maaMeldeBetaFejl(id: Pick<GateIdentitet, "rolle" | "kontoType" | "beta">): boolean {
  if (id.rolle && STAFF_ROLLER.includes(id.rolle)) return true;
  if (id.kontoType === "erhverv") return false;
  return id.beta;
}

// Bruger-id'et, hvis knappen skal vises, ellers null.
export const betaFejlKnapBruger = cache(async (): Promise<string | null> => {
  if (!foerLancering()) return null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    const sub = data?.claims?.sub;
    const sessionId = data?.claims?.session_id;
    if (typeof sub !== "string" || typeof sessionId !== "string") return null;
    const id = await laesRolleCookie((await cookies()).get(ROLLE_COOKIE)?.value, sub, sessionId);
    return id && maaMeldeBetaFejl(id) ? sub : null;
  } catch (err) {
    unstable_rethrow(err);
    return null;
  }
});
