"use server";

// Sikkerhed på /konto: skift adgangskode, to-trins-login (TOTP) og enheder.
// Alt udledes af den indloggede bruger (getUser) - der tages aldrig et
// bruger-id fra klienten. Fejl RETURNERES som { fejl }.
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { FOR_MANGE_FORSOEG, tjekGraenser } from "@/lib/rateLimit";
import { vurderAdgangskode } from "@/lib/adgangskode";
import { bekraeftAdgangskode } from "@/lib/bekraeftAdgangskode";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import { adgangskodeAendretMail, toTrinMail } from "@/lib/mails/konto";
import { logDriftFejl } from "@/lib/drift";
import { manglerToTrin } from "@/lib/mfa";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const IKKE_LOGGET_IND = "Du er ikke logget ind længere. Log ind igen.";
const TO_TRIN_MANGLER = "Indtast først koden fra din godkendelses-app. Log ud og ind igen, hvis du ikke bliver bedt om den.";
const GENLOG_IND = "Af sikkerhedshensyn skal du logge ud og ind igen, før du kan skifte adgangskode.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ok = { ok: true };
type Fejl = { fejl: string };

// toTrinMangler: brugeren har to-trins-login, men sessionen har kun
// adgangskoden (aal1). Alle handlinger herunder kræver fuldt login - proxyen
// alene er ikke nok, da en server action kan kaldes via en offentlig sti.
async function hentBruger() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const bruger = data.user;
  const toTrinMangler = bruger ? await manglerToTrin(supabase, bruger) : false;
  return { supabase, bruger, toTrinMangler };
}

function renKode(v: unknown): string | null {
  const k = typeof v === "string" ? v.replace(/\s+/g, "") : "";
  return /^\d{6}$/.test(k) ? k : null;
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
  const { supabase, bruger, toTrinMangler } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  if (toTrinMangler) return { fejl: TO_TRIN_MANGLER };
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
    if (error.code === "insufficient_aal") return { fejl: "Log ind med din kode fra appen igen, og prøv så igen." };
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

// ------------------------------------------------------------ To-trins-login

export async function startToTrin(): Promise<
  { ok: true; faktorId: string; qrKode: string; hemmelighed: string } | Fejl
> {
  const { supabase, bruger, toTrinMangler } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  if (toTrinMangler) return { fejl: TO_TRIN_MANGLER };
  if (!(await tjekGraenser([["mfa_bruger", bruger.id]]))) return { fejl: FOR_MANGE_FORSOEG };

  const { data: faktorer, error: listeFejl } = await supabase.auth.mfa.listFactors();
  if (listeFejl) {
    console.error("startToTrin: listFactors fejlede:", listeFejl.message);
    return { fejl: GENERISK };
  }
  if (faktorer.totp.some((f) => f.status === "verified")) {
    return { fejl: "To-trins-login er allerede slået til." };
  }
  // Ryd halvfærdige forsøg, så der kun er én app ad gangen.
  for (const f of faktorer.all) {
    if (f.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: f.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    issuer: "BidHamr",
    friendlyName: `BidHamr ${new Date().toISOString().slice(0, 16)}`,
  });
  if (error || !data || data.type !== "totp") {
    console.error("startToTrin: enroll fejlede:", error?.code, error?.message);
    return { fejl: GENERISK };
  }
  return { ok: true, faktorId: data.id, qrKode: data.totp.qr_code, hemmelighed: data.totp.secret };
}

export async function bekraeftNyToTrin(faktorId: string, kodeInput: string): Promise<Ok | Fejl> {
  const kode = renKode(kodeInput);
  if (!kode) return { fejl: "Koden består af 6 cifre." };
  if (typeof faktorId !== "string" || !UUID.test(faktorId)) return { fejl: GENERISK };

  const { supabase, bruger, toTrinMangler } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  if (toTrinMangler) return { fejl: TO_TRIN_MANGLER };
  if (!(await tjekGraenser([["mfa_bruger", bruger.id]]))) return { fejl: FOR_MANGE_FORSOEG };
  // Faktoren skal tilhøre brugeren (Supabase tjekker det også).
  if (!bruger.factors?.some((f) => f.id === faktorId)) return { fejl: "Start forfra, og scan QR-koden igen." };

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: faktorId, code: kode });
  if (error) {
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    return { fejl: "Koden passer ikke. Tjek, at uret på din telefon går rigtigt, og prøv med den nye kode." };
  }

  await sendSikkerhedsmail(bruger.id, bruger.email, toTrinMail({ slaaetTil: true, tidspunkt: new Date() }));
  revalidatePath("/konto");
  return { ok: true };
}

export async function annullerNyToTrin(faktorId: string): Promise<Ok | Fejl> {
  if (typeof faktorId !== "string" || !UUID.test(faktorId)) return { ok: true };
  const { supabase, bruger, toTrinMangler } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  if (toTrinMangler) return { fejl: TO_TRIN_MANGLER };
  const faktor = bruger.factors?.find((f) => f.id === faktorId);
  // Kun halvfærdige faktorer kan annulleres herfra.
  if (faktor && faktor.status !== "verified") await supabase.auth.mfa.unenroll({ factorId: faktorId });
  return { ok: true };
}

export async function slaaToTrinFra(kodeInput: string): Promise<Ok | Fejl> {
  const kode = renKode(kodeInput);
  if (!kode) return { fejl: "Koden består af 6 cifre." };

  const { supabase, bruger, toTrinMangler } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  if (toTrinMangler) return { fejl: TO_TRIN_MANGLER };
  if (!(await tjekGraenser([["mfa_bruger", bruger.id]]))) return { fejl: FOR_MANGE_FORSOEG };

  const verificerede = bruger.factors?.filter((f) => f.status === "verified") ?? [];
  if (verificerede.length === 0) return { fejl: "To-trins-login er ikke slået til." };

  // Koden kræves, selvom sessionen allerede er aal2: den, der slår det fra,
  // skal have appen.
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: verificerede[0].id, code: kode });
  if (error) {
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    return { fejl: "Koden passer ikke. Prøv med den nye kode fra din app." };
  }

  for (const f of verificerede) {
    const { error: fejl } = await supabase.auth.mfa.unenroll({ factorId: f.id });
    if (fejl) {
      console.error("slaaToTrinFra: unenroll fejlede:", fejl.code, fejl.message);
      return { fejl: GENERISK };
    }
  }

  await sendSikkerhedsmail(bruger.id, bruger.email, toTrinMail({ slaaetTil: false, tidspunkt: new Date() }));
  revalidatePath("/konto");
  return { ok: true };
}

// ------------------------------------------------------------ Enheder

export async function fjernEnhed(id: string): Promise<Ok | Fejl> {
  if (typeof id !== "string" || !UUID.test(id)) return { fejl: GENERISK };
  const { supabase, bruger, toTrinMangler } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  if (toTrinMangler) return { fejl: TO_TRIN_MANGLER };
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
  const { supabase, bruger, toTrinMangler } = await hentBruger();
  if (!bruger) return { fejl: IKKE_LOGGET_IND };
  if (toTrinMangler) return { fejl: TO_TRIN_MANGLER };
  if (!(await tjekGraenser([["enheder_bruger", bruger.id]]))) return { fejl: FOR_MANGE_FORSOEG };

  const { error } = await supabase.auth.signOut({ scope: "others" });
  if (error) {
    console.error("logUdAndreSteder fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }
  revalidatePath("/konto");
  return { ok: true };
}
