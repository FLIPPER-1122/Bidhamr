"use server";

// Sikkerhed på /konto: skift adgangskode og enheder.
// Alt udledes af den indloggede bruger (getUser) - der tages aldrig et
// bruger-id fra klienten. Fejl RETURNERES som { fejl }.
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { FOR_MANGE_FORSOEG, tjekGraenser } from "@/lib/rateLimit";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { skiftAdgangskodeFor } from "@/lib/adgangskodeSkift";
import { rydAdminMfa } from "@/lib/enheder";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const IKKE_LOGGET_IND = "Du er ikke logget ind længere. Log ind igen.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ok = { ok: true };
type Fejl = { fejl: string };

// Alle handlinger herunder kræver login - proxyen alene er ikke nok, da en
// server action kan kaldes via en offentlig sti.
async function hentBruger() {
  const supabase = await createClient();
  const { data } = await hentLoggetIndBruger(supabase);
  return { supabase, bruger: data.user };
}

// ------------------------------------------------------------ Adgangskode

// Logikken deles med appen (POST /api/konto/adgangskode) i
// src/lib/adgangskodeSkift.ts - her med brugerens cookie-session.
export async function skiftAdgangskode(nuvaerende: string, ny: string): Promise<Ok | Fejl> {
  const { supabase, bruger } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  const r = await skiftAdgangskodeFor({
    bruger,
    nuvaerende,
    ny,
    saetAdgangskode: async (kode) => (await supabase.auth.updateUser({ password: kode })).error,
    logUdAndre: async () => (await supabase.auth.signOut({ scope: "others" })).error,
  });
  if ("fejl" in r) return { fejl: r.fejl };
  revalidatePath("/konto");
  return { ok: true };
}

// ------------------------------------------------------------ Enheder

export async function fjernEnhed(id: string): Promise<Ok | Fejl> {
  if (typeof id !== "string" || !UUID.test(id)) return { fejl: GENERISK };
  const { supabase, bruger } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  if (!(await tjekGraenser([["enheder_bruger", bruger.id]]))) return { fejl: FOR_MANGE_FORSOEG };

  const { data, error } = await supabase.rpc("fjern_min_enhed", { p_id: id });
  if (error) {
    console.error("fjernEnhed fejlede:", error.message);
    return { fejl: GENERISK };
  }
  const kode = (data as { kode?: string } | null)?.kode;
  if (kode === "denne_enhed") return { fejl: "Det er den enhed, du bruger nu. Brug \"Log ud\" i stedet." };
  if (kode !== "ok") return { fejl: "Enheden findes ikke længere. Genindlæs siden." };
  revalidatePath("/konto");
  return { ok: true };
}

export async function logUdAndreSteder(): Promise<Ok | Fejl> {
  const { supabase, bruger } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  if (!(await tjekGraenser([["enheder_bruger", bruger.id]]))) return { fejl: FOR_MANGE_FORSOEG };

  const { error } = await supabase.auth.signOut({ scope: "others" });
  if (error) {
    console.error("logUdAndreSteder fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }
  // Ingen enhed er længere kendt for admin-loginets loft pr. e-mail
  // (20261102430000) - den skal igennem to-trins-loginet igen.
  await rydAdminMfa(bruger.id);
  revalidatePath("/konto");
  return { ok: true };
}
