import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

// MitID-status for en bruger - hentet højst én gang pr. forespørgsel.
// users.mitid_verificeret_kl og konto_type kan læses af alle (offentligt
// mærke). Databasen håndhæver kravet (BHV01) - dette er kun til visning.
export type MitIdStatus = {
  verificeretKl: string | null;
  // Skal brugeren bekræfte sig, før han byder/sælger? (Firmakonti er undtaget.)
  mangler: boolean;
};

export const hentMitIdStatus = cache(async (brugerId: string): Promise<MitIdStatus> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("users")
    .select("konto_type, mitid_verificeret_kl")
    .eq("id", brugerId)
    .maybeSingle<{ konto_type: string | null; mitid_verificeret_kl: string | null }>();
  const verificeretKl = data?.mitid_verificeret_kl ?? null;
  return { verificeretKl, mangler: !!data && data.konto_type !== "erhverv" && !verificeretKl };
});
