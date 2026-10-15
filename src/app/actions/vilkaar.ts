"use server";

// Accept af brugerbetingelserne for eksisterende brugere (det blokerende
// vindue, src/components/vilkaar/VilkaarDialog.tsx).
// accepter_vilkaar(p_version) udleder brugeren af auth.uid(), godtager kun
// den aktuelle version og gemmer databasens tidspunkt
// (supabase/migrations/20261009050000_vilkaar_accept.sql).

import { revalidatePath } from "next/cache";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { erVilkaarVersion } from "@/lib/vilkaar";

type Svar = { ok: true } | { fejl: string };

// version: den version, brugeren har fået vist (databasens aktuelle, fra
// mine_vilkaar). Databasen afviser alt andet end den aktuelle version.
export async function accepterVilkaar(version: string): Promise<Svar> {
  if (!erVilkaarVersion(version)) {
    return { fejl: "Brugerbetingelserne er blevet opdateret. Genindlæs siden, og læs dem igen." };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind." };

  const { error } = await supabase.rpc("accepter_vilkaar", { p_version: version });
  if (error) {
    // Ny version imens (gammel fane): bed brugeren genindlæse.
    if (error.message.includes("opdateret")) {
      return { fejl: "Brugerbetingelserne er blevet opdateret. Genindlæs siden, og læs dem igen." };
    }
    console.error("accepter_vilkaar fejlede:", error.message);
    return { fejl: "Din accept kunne ikke gemmes. Prøv igen om lidt." };
  }
  revalidatePath("/konto");
  return { ok: true };
}
