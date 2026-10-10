import "server-only";

import { cache } from "react";
import { hentKontoFelter } from "@/lib/supabase/bruger";

// MitID-status for en bruger - hentet højst én gang pr. forespørgsel.
// users.mitid_verificeret_kl og konto_type kan læses af alle (offentligt
// mærke). Databasen håndhæver kravet (BHV01) - dette er kun til visning.
export type MitIdStatus = {
  verificeretKl: string | null;
  // Skal brugeren bekræfte sig, før han byder/sælger? (Firmakonti er undtaget.)
  mangler: boolean;
};

export const hentMitIdStatus = cache(async (brugerId: string): Promise<MitIdStatus> => {
  // Samme opslag som hentKontoType (delt med topbaren - ét kald pr. side).
  const data = await hentKontoFelter(brugerId);
  const verificeretKl = data?.mitid_verificeret_kl ?? null;
  return { verificeretKl, mangler: !!data && data.konto_type !== "erhverv" && !verificeretKl };
});
