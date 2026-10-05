"use server";

// Brugeren sletter selv sin konto fra hjemmesiden (/konto/slet). Selve
// sletningen ligger i src/lib/kontoSletning.ts, som appen også bruger via
// POST /api/konto/slet.
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { manglerToTrin } from "@/lib/mfa";
import { ENHED_COOKIE } from "@/lib/enheder";
import { udfoerKontoSletning, type Blokering } from "@/lib/kontoSletning";

export type { Blokering };

export async function sletMinKonto(input: {
  adgangskode: string;
  bekraeftelse: string;
}): Promise<{ ok: true } | { fejl: string; blokeringer?: Blokering[] }> {
  const supabase = await createClient();
  const { data: brugerData } = await supabase.auth.getUser();
  const bruger = brugerData.user;
  if (!bruger) return { fejl: "Du er ikke logget ind længere. Log ind igen." };
  // Har brugeren to-trins-login, skal sessionen have koden (aal2). Proxyen
  // tjekker det også, men en server action kan kaldes via en offentlig sti.
  if (await manglerToTrin(supabase, bruger)) {
    return { fejl: "Indtast først koden fra din godkendelses-app. Log ud og ind igen, hvis du ikke bliver bedt om den." };
  }

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
