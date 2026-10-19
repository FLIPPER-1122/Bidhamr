import "server-only";

// To-trins-login for staff på admin-hosten - server-delen (Supabase MFA TOTP).
// Reglerne: src/lib/staffToTrinRegler.ts. Arkitektur: docs/ADMIN-VAERT.md.
import { createHash, randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { sendHandelMailDetaljer } from "@/lib/mails/send";
import {
  gendannelseHashTekst,
  lavGendannelseskoder,
  renTotpKode,
} from "@/lib/staffToTrinRegler";

export function nyeGendannelseskoder(): string[] {
  return lavGendannelseskoder((max) => randomInt(max));
}

export function hashGendannelseskode(brugerId: string, kode: string): string | null {
  const tekst = gendannelseHashTekst(brugerId, kode);
  return tekst ? createHash("sha256").update(tekst).digest("hex") : null;
}

// Status fra databasen for den indloggede (min_staff_adgang, auth.uid()).
export type MinStaffStatus = {
  staff: boolean;
  rolle: string | null;
  aktiv: boolean;
  ukendte_faktorer: boolean;
  tilmelding_aaben: boolean;
  tilmelding_aaben_til: string | null;
  aal: string;
};

export async function minStaffStatus(supabase: SupabaseClient): Promise<MinStaffStatus | null> {
  const { data, error } = await supabase.rpc("min_staff_adgang");
  if (error) {
    console.error("min_staff_adgang fejlede:", error.code, error.message);
    return null;
  }
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    staff: d.staff === true,
    rolle: typeof d.rolle === "string" ? d.rolle : null,
    aktiv: d.aktiv === true,
    ukendte_faktorer: d.ukendte_faktorer === true,
    tilmelding_aaben: d.tilmelding_aaben === true,
    tilmelding_aaben_til: typeof d.tilmelding_aaben_til === "string" ? d.tilmelding_aaben_til : null,
    aal: typeof d.aal === "string" ? d.aal : "aal1",
  };
}

// De faktorer, serveren har godkendt (staff_to_trin.faktor_ider).
export async function godkendteFaktorer(brugerId: string): Promise<string[] | null> {
  const { data, error } = await createAdminClient()
    .from("staff_to_trin")
    .select("faktor_ider, aktiv")
    .eq("bruger_id", brugerId)
    .maybeSingle<{ faktor_ider: string[] | null; aktiv: boolean }>();
  if (error) {
    console.error("staff_to_trin kunne ikke læses:", error.message);
    return null;
  }
  return data?.aktiv ? (data.faktor_ider ?? []) : [];
}

type Faktor = { id: string; factor_type: string; status: string };

async function listFaktorer(brugerId: string): Promise<Faktor[] | null> {
  const { data, error } = await createAdminClient().auth.admin.mfa.listFactors({ userId: brugerId });
  if (error) {
    console.error("listFactors fejlede:", error.message);
    return null;
  }
  return ((data?.factors ?? []) as Faktor[]).map((f) => ({ id: f.id, factor_type: f.factor_type, status: f.status }));
}

async function sletFaktor(brugerId: string, id: string): Promise<boolean> {
  const { error } = await createAdminClient().auth.admin.mfa.deleteFactor({ userId: brugerId, id });
  if (error) {
    console.error("deleteFactor fejlede:", error.message);
    return false;
  }
  return true;
}

// Før en ny app sættes op: alle brugerens faktorer slettes (gamle efter en
// nulstilling, halvfærdige og ukendte). Supabase kræver desuden aal2 for at
// tilmelde en ny faktor, hvis der allerede findes en verificeret.
export async function sletAlleFaktorer(brugerId: string): Promise<boolean> {
  const faktorer = await listFaktorer(brugerId);
  if (!faktorer) return false;
  let ok = true;
  for (const f of faktorer) ok = (await sletFaktor(brugerId, f.id)) && ok;
  return ok;
}

// Efter hver mfa.verify: kun de godkendte faktorer må findes. En verificeret
// faktor, serveren ikke kender (fx oprettet direkte mod Supabase med brugerens
// token), slettes, og der gives drift-alarm. Halvfærdige (unverified) slettes
// stille. Returnerer antallet af ukendte, verificerede faktorer (null ved fejl).
export async function rydUkendteFaktorer(brugerId: string, godkendte: string[]): Promise<number | null> {
  const faktorer = await listFaktorer(brugerId);
  if (!faktorer) return null;
  let ukendte = 0;
  for (const f of faktorer) {
    if (godkendte.includes(f.id)) continue;
    if (f.status === "verified") ukendte++;
    await sletFaktor(brugerId, f.id);
  }
  if (ukendte > 0) {
    await logDriftFejl({
      kilde: "server",
      sti: "/adgang/kode",
      hvor: "To-trins-login: ukendt faktor",
      fejl: `${ukendte} ukendt(e) faktor(er) slettet for medarbejder ${brugerId}. Faktoren var ikke sat op via admin - tjek medarbejder-loggen.`,
      brugerId,
    });
  }
  return ukendte;
}

// Udfordring og bekræftelse af en kode fra app'en med brugerens egen klient
// (cookie-sessionen). Lykkes det, sættes en ny aal2-session i cookien.
export async function bekraeftTotp(
  supabase: SupabaseClient,
  faktorId: string,
  kodeInput: unknown,
): Promise<"ok" | "ugyldig" | "forkert" | "fejl"> {
  const kode = renTotpKode(kodeInput);
  if (!kode) return "ugyldig";
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: faktorId, code: kode });
  if (!error) return "ok";
  // invalid_credentials / mfa_verification_failed: forkert kode.
  if (error.status === 400 || error.status === 422 || /invalid|verification/i.test(error.code ?? "")) {
    return "forkert";
  }
  console.error("mfa.challengeAndVerify fejlede:", error.status, error.code, error.message);
  return "fejl";
}

// Den godkendte faktor, der skal bruges til en kode (den første, der stadig
// findes som verificeret TOTP).
export async function aktivTotpFaktor(brugerId: string): Promise<string | null> {
  const [godkendte, faktorer] = await Promise.all([godkendteFaktorer(brugerId), listFaktorer(brugerId)]);
  if (!godkendte || !faktorer) return null;
  const f = faktorer.find((x) => godkendte.includes(x.id) && x.status === "verified" && x.factor_type === "totp");
  return f?.id ?? null;
}

// Sikkerhedsmail til medarbejderen (fejl logges, men stopper ikke handlingen).
export async function sendSikkerhedsmail(
  brugerId: string,
  mail: { subject: string; html: string; text?: string },
): Promise<void> {
  try {
    const { data, error } = await createAdminClient().auth.admin.getUserById(brugerId);
    const email = data?.user?.email;
    if (error || !email) {
      console.error("Sikkerhedsmail: e-mail kunne ikke findes", error?.message);
      return;
    }
    const r = await sendHandelMailDetaljer(email, mail);
    if (!r.ok) console.error("Sikkerhedsmail fejlede:", r.fejl);
  } catch (err) {
    console.error("Sikkerhedsmail kastede:", err);
  }
}
