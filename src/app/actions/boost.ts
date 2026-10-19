"use server";

// Boost på hjemmesiden: køb af boost-point (Min konto -> Boost-point) og
// "Boost i 24 timer" på egen auktion. Samme kode som appens endpoints
// (src/lib/betaling/boost.ts). Brugeren findes altid ud fra sessionen -
// aldrig fra klienten. Beløb og point kommer fra databasen.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { tjekGraenser, FOR_MANGE_FORSOEG } from "@/lib/rateLimit";
import { brugBoost, PAKKE_ID, startBoostKoeb, type BoostBrug, type BoostStart } from "@/lib/betaling/boost";
import { BOOST_TEKST } from "@/lib/boost/tekster";

const IKKE_LOGGET_IND = "Du er ikke logget ind længere. Log ind igen.";

async function indloggetBrugerId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  return user?.id ?? null;
}

// Start (eller genoptag) et køb af point. pakke: pakkens id (boost_pakker) -
// kun id'et; pris og point vælger databasen. Svar: client secret til
// Stripes Payment Element - eller en fejl.
export async function startBoostKoebAction(samtykke = false, pakke: unknown = null): Promise<BoostStart> {
  const brugerId = await indloggetBrugerId();
  if (!brugerId) return { fejl: IKKE_LOGGET_IND, kode: "ikke_fundet" };
  if (pakke !== null && pakke !== undefined && (typeof pakke !== "string" || !PAKKE_ID.test(pakke))) {
    return { fejl: BOOST_TEKST.pakkeUkendt, kode: "pakke_ukendt" };
  }
  if (!(await tjekGraenser([["boost_bruger", brugerId]]))) return { fejl: FOR_MANGE_FORSOEG, kode: "fejl" };
  return startBoostKoeb(brugerId, "web", samtykke === true, typeof pakke === "string" ? pakke : null);
}

// "Boost i 24 timer (50 point)" på egen auktion. noegle: klientens uuid
// (samme nøgle = samme boost - dobbeltklik trækker ikke point to gange).
export async function brugBoostAction(auktionId: string, noegle: string): Promise<BoostBrug> {
  const brugerId = await indloggetBrugerId();
  if (!brugerId) return { fejl: IKKE_LOGGET_IND, kode: "ugyldig" };
  if (!(await tjekGraenser([["boost_bruger", brugerId]]))) return { fejl: FOR_MANGE_FORSOEG, kode: "fejl" };
  const r = await brugBoost(brugerId, auktionId, noegle);
  if ("ok" in r) {
    revalidatePath(`/auktion/${auktionId}`);
    revalidatePath("/");
  }
  return r;
}
