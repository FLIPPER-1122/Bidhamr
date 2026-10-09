"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { indenForGraense, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { gemSkatteoplysninger, type GemSvar } from "@/lib/dac7/server";
import { DAC7 } from "@/lib/dac7/tekster";

// Min konto → Skatteoplysninger (DAC7): sælgeren gemmer adresse og CPR.
// Brugeren findes ud fra sessionen - aldrig fra formularen. CPR krypteres i
// src/lib/dac7/server.ts, før det sendes til databasen, og logges aldrig.
export async function gemMineSkatteoplysninger(formData: FormData): Promise<GemSvar> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await hentLoggetIndBruger(supabase);
    if (!user) return { fejl: DAC7.fejl.ikkeLoggetInd, kode: "ikke_logget_ind" };
    if (!(await indenForGraense("dac7_gem_bruger", user.id))) {
      return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
    }
    const res = await gemSkatteoplysninger(user.id, {
      adresse: formData.get("adresse"),
      postnummer: formData.get("postnummer"),
      bynavn: formData.get("bynavn"),
      cpr: formData.get("cpr"),
      andetTinLand: formData.get("andetTinLand"),
      andetTinNummer: formData.get("andetTinNummer"),
      beholdAndetTin: formData.get("beholdAndetTin") === "ja",
      bekraeft: formData.get("bekraeft") === "ja",
    });
    if ("ok" in res) revalidatePath("/konto/skat");
    return res;
  } catch (err) {
    // Fejlen kan aldrig indeholde CPR-nummeret (det er krypteret, før
    // databasen kaldes, og indgår ikke i fejltekster).
    await logDriftFejl({ kilde: "server", sti: "/konto/skat", hvor: "DAC7: gem oplysninger", fejl: err });
    return { fejl: DAC7.fejl.generisk, kode: "fejl" };
  }
}
