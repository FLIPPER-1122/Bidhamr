"use server";

// Brugeren sletter selv sin konto fra hjemmesiden (/konto/slet). Selve
// sletningen ligger i src/lib/kontoSletning.ts, som appen også bruger via
// POST /api/konto/slet.
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { ENHED_COOKIE } from "@/lib/enheder";
import { udfoerKontoSletning, type Blokering } from "@/lib/kontoSletning";

export type { Blokering };

export async function sletMinKonto(input: {
  adgangskode: string;
  bekraeftelse: string;
}): Promise<{ ok: true } | { fejl: string; blokeringer?: Blokering[] }> {
  const supabase = await createClient();
  const { data: brugerData } = await hentLoggetIndBruger(supabase);
  const bruger = brugerData.user;
  if (!bruger) return { fejl: "Du er ikke logget ind længere. Log ind igen." };

  const svar = await udfoerKontoSletning({
    bruger,
    adgangskode: input?.adgangskode,
    bekraeftelse: input?.bekraeftelse,
    logUdAlleSteder: async () => {
      await supabase.auth.signOut({ scope: "global" });
    },
  });
  if ("fejl" in svar) {
    return svar.blokeringer ? { fejl: svar.fejl, blokeringer: svar.blokeringer } : { fejl: svar.fejl };
  }

  const jar = await cookies();
  jar.delete(ENHED_COOKIE);
  return { ok: true };
}
