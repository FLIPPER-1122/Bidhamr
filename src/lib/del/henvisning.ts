import "server-only";

import { createClient } from "@/lib/supabase/server";
import { hentMinHenvisning } from "@/lib/henvisning/status";

// Del-knappen på auktionssiden lægger den indloggede brugers egen kode fra
// "Henvis en ven" i linket (?ven=<kode>, HENVISNING_PARAM). min_henvisning()
// bruger auth.uid() og giver kun en kode til private konti - firmaer kan ikke
// få point, så deres links indeholder kun auktionens id.
export async function henvisningskodeTilDeling(brugerId: string | null): Promise<string | null> {
  if (!brugerId) return null;
  const min = await hentMinHenvisning(await createClient());
  return min?.kan_henvise ? min.kode : null;
}
