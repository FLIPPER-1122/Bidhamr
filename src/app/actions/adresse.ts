"use server";

import { revalidatePath } from "next/cache";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { FOR_MANGE_FORSOEG, tjekGraenser } from "@/lib/rateLimit";
import { gemMinAdresse, type GemAdresseSvar } from "@/lib/adresse/server";

// Min adresse og formularen før første bud/betaling. Brugeren udledes af
// sessionen (gem_min_adresse bruger auth.uid()). Fejl RETURNERES.
export async function gemMinAdresseAction(input: { adresse: string; postnummer: string }): Promise<GemAdresseSvar> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind." };
  if (!(await tjekGraenser([["adresse_bruger", user.id]]))) return { fejl: FOR_MANGE_FORSOEG };

  const svar = await gemMinAdresse(supabase, user.id, { adresse: input?.adresse, postnummer: input?.postnummer });
  if ("ok" in svar) revalidatePath("/konto/adresse");
  return svar;
}
