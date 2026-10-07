"use server";

// Sikkerhed på /konto: skift adgangskode og enheder.
// Alt udledes af den indloggede bruger (getUser) - der tages aldrig et
// bruger-id fra klienten. Fejl RETURNERES som { fejl }.
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { FOR_MANGE_FORSOEG, tjekGraenser } from "@/lib/rateLimit";
import { vurderAdgangskode } from "@/lib/adgangskode";
import { bekraeftAdgangskode } from "@/lib/bekraeftAdgangskode";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { adgangskodeAendretMail } from "@/lib/mails/konto";
import { logDriftFejl } from "@/lib/drift";
import { hentLoggetIndBruger } from "@/lib/hentBruger";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const IKKE_LOGGET_IND = "Du er ikke logget ind længere. Log ind igen.";
const GENLOG_IND = "Af sikkerhedshensyn skal du logge ud og ind igen, før du kan skifte adgangskode.";
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

async function sendSikkerhedsmail(
  brugerId: string,
  email: string | undefined,
  mail: { subject: string; html: string; text: string },
) {
  if (!email) return;
  const res = await sendHandelMailDetaljer(email, mail);
  if (!res.ok) await logDriftFejl({ kilde: "action", hvor: "sikkerhedsmail", fejl: res.fejl, brugerId });
}

// ------------------------------------------------------------ Adgangskode

export async function skiftAdgangskode(nuvaerende: string, ny: string): Promise<Ok | Fejl> {
  const { supabase, bruger } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  if (!(await tjekGraenser([["adgangskode_bruger", bruger.id]]))) return { fejl: FOR_MANGE_FORSOEG };

  const { data: profil } = await createAdminClient()
    .from("users")
    .select("navn, fornavn, efternavn")
    .eq("id", bruger.id)
    .maybeSingle();
  const v = vurderAdgangskode(ny, { email: bruger.email, navn: [profil?.navn, profil?.fornavn, profil?.efternavn] });
  if (!v.ok) return { fejl: v.fejl ?? GENERISK };
  if (ny === nuvaerende) return { fejl: "Den nye adgangskode skal være en anden end den nuværende." };

  const tjek = await bekraeftAdgangskode(bruger.email, nuvaerende);
  if (tjek === "forkert") return { fejl: "Din nuværende adgangskode er forkert." };
  if (tjek === "for_mange") return { fejl: FOR_MANGE_FORSOEG };
  if (tjek !== "ok") return { fejl: GENERISK };

  const { error } = await supabase.auth.updateUser({ password: ny });
  if (error) {
    if (error.code === "same_password") return { fejl: "Den nye adgangskode skal være en anden end den nuværende." };
    if (error.code === "weak_password") return { fejl: "Adgangskoden er for svag. Vælg en længere og mindre almindelig adgangskode." };
    if (error.code === "reauthentication_needed") return { fejl: GENLOG_IND };
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    console.error("skiftAdgangskode fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }

  // Andre enheder logges ud - denne bliver logget ind.
  const { error: udFejl } = await supabase.auth.signOut({ scope: "others" });
  if (udFejl) console.error("skiftAdgangskode: andre sessioner blev ikke logget ud:", udFejl.message);
  await sendSikkerhedsmail(bruger.id, bruger.email, adgangskodeAendretMail({ tidspunkt: new Date() }));
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
  revalidatePath("/konto");
  return { ok: true };
}
