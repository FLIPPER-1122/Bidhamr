"use server";

// Accept af brugerbetingelserne for eksisterende brugere (bjælken på /konto).
// accepter_vilkaar(p_version) udleder brugeren af auth.uid(), godtager kun
// den aktuelle version og gemmer databasens tidspunkt
// (supabase/migrations/20261009050000_vilkaar_accept.sql).

import { revalidatePath } from "next/cache";
import { getUserMedToTrin } from "@/lib/mfa";
import { createClient } from "@/lib/supabase/server";
import { VILKAAR_VERSION } from "@/lib/vilkaar";

type Svar = { ok: true } | { fejl: string };

export async function accepterVilkaar(version: string): Promise<Svar> {
  if (version !== VILKAAR_VERSION) {
    return { fejl: "Brugerbetingelserne er blevet opdateret. Genindlæs siden, og læs dem igen." };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await getUserMedToTrin(supabase);
  if (!user) return { fejl: "Du skal være logget ind." };

  const { error } = await supabase.rpc("accepter_vilkaar", { p_version: version });
  if (error) {
    console.error("accepter_vilkaar fejlede:", error.message);
    return { fejl: "Din accept kunne ikke gemmes. Prøv igen om lidt." };
  }
  revalidatePath("/konto");
  return { ok: true };
}
