import "server-only";

// Velkomstlinket til en ny firmakonto (20261102040000).
//
// Supabases engangslinks (generateLink) udløber efter projektets "Email OTP
// expiration" (i dag 1 time) - det ændres ikke. Velkomstmailen indeholder
// derfor BidHamrs egen billet, der gælder i VELKOMST_TIMER timer:
//   /auth/velkomst?b=<billet>  (src/app/auth/velkomst/route.ts)
// Hver gang billetten åbnes, laves et FRISK Supabase-link (generateLink
// 'recovery' - sender ingen mail), og firmaet sendes videre til mellemsiden
// /bekraeft (én knap, der logger ind og fører til "Vælg din adgangskode").
// Mail-scannere, der åbner linket først, bruger derfor ikke noget op.
//
// Billetten er ugyldig, når den er udløbet, når staff har sendt en ny (den
// gamle annulleres), når knappen på /bekraeft er trykket, og login er lykkedes
// (brugt_kl, sat af /auth/callback - 20261102060000), eller når firmaet har
// logget ind på anden vis (så bruges "Glemt adgangskode"). Kun sha256-hashen
// gemmes i databasen.

import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { sideUrl } from "@/lib/mails/layout";

export const VELKOMST_TIMER = 24;
const BILLET = /^[A-Za-z0-9_-]{43}$/;

type Admin = ReturnType<typeof createAdminClient>;

function hash(billet: string): string {
  return createHash("sha256").update(billet, "utf8").digest("hex");
}

// Nøgle til rate limit pr. billet (aldrig selve billetten, som er et login).
export function velkomstBilletNoegle(billet: string): string {
  return hash(billet).slice(0, 32);
}

export function erVelkomstBillet(v: unknown): v is string {
  return typeof v === "string" && BILLET.test(v);
}

function tabelMangler(err: { code?: string } | null | undefined): boolean {
  return err?.code === "42P01" || err?.code === "PGRST205";
}

// Udsteder en ny billet til firmaets login (og annullerer de tidligere).
// Svarer med linket til mailen - eller null, hvis migrationen 20261102040000
// ikke er kørt (så bruger kalderen det gamle Supabase-link på 1 time).
export async function udstedVelkomstBillet(
  admin: Admin,
  brugerId: string,
  staffId: string | null,
): Promise<string | null> {
  const billet = randomBytes(32).toString("base64url");
  const nu = Date.now();
  const { error: annFejl } = await admin
    .from("firma_velkomst_billetter")
    .update({ annulleret_kl: new Date(nu).toISOString() })
    .eq("bruger_id", brugerId)
    .is("annulleret_kl", null);
  if (tabelMangler(annFejl)) return null;
  if (annFejl) throw new Error(`firma_velkomst_billetter (annuller): ${annFejl.message}`);
  const { error } = await admin.from("firma_velkomst_billetter").insert({
    bruger_id: brugerId,
    token_hash: hash(billet),
    udloeber_kl: new Date(nu + VELKOMST_TIMER * 3600_000).toISOString(),
    oprettet_af: staffId,
  });
  if (tabelMangler(error)) return null;
  if (error) throw new Error(`firma_velkomst_billetter (ny): ${error.message}`);
  return sideUrl(`/auth/velkomst?b=${billet}`);
}

// Markerer firmaets aktive velkomstbilletter som brugt (brugt_kl,
// 20261102060000). Kaldes af /auth/callback, når knappen på /bekraeft er
// trykket fra et velkomstlink, og login er lykkedes. Herefter kan billetten
// ikke lave flere friske links (heller ikke hvis mailen videresendes).
// Kaster aldrig - fejler det, gælder last_sign_in_at-tjekket stadig.
export async function markerVelkomstBilletBrugt(admin: Admin, brugerId: string): Promise<void> {
  try {
    const { error } = await admin
      .from("firma_velkomst_billetter")
      .update({ brugt_kl: new Date().toISOString() })
      .eq("bruger_id", brugerId)
      .is("brugt_kl", null)
      .is("annulleret_kl", null);
    // Tabellen eller kolonnen findes ikke endnu (migrationen er ikke kørt).
    if (error && !tabelMangler(error) && error.code !== "42703" && error.code !== "PGRST204") {
      console.error("firma_velkomst_billetter (brugt):", error.code, error.message);
    }
  } catch (err) {
    console.error("firma_velkomst_billetter (brugt):", err);
  }
}

export type VelkomstOpslag =
  | { kode: "ok"; email: string }
  | { kode: "ugyldig" | "udloebet" | "logget_ind" };

// Slår billetten op (forbruger den ikke). "ok": billetten gælder, og firmaet
// har aldrig logget ind - så må der laves et frisk Supabase-link.
export async function slaaVelkomstBilletOp(admin: Admin, billet: string): Promise<VelkomstOpslag> {
  if (!erVelkomstBillet(billet)) return { kode: "ugyldig" };
  // "*": brugt_kl findes først efter 20261102060000 (service role - ingen
  // kolonne-grants at tage hensyn til).
  const { data, error } = await admin
    .from("firma_velkomst_billetter")
    .select("*")
    .eq("token_hash", hash(billet))
    .maybeSingle<{
      id: string;
      bruger_id: string;
      udloeber_kl: string;
      annulleret_kl: string | null;
      aabnet_antal: number;
      brugt_kl?: string | null;
    }>();
  if (tabelMangler(error)) return { kode: "ugyldig" };
  if (error) throw new Error(`firma_velkomst_billetter: ${error.message}`);
  if (!data) return { kode: "ugyldig" };
  // Brugt: firmaet har trykket på knappen på /bekraeft og er logget ind.
  if (data.brugt_kl) return { kode: "logget_ind" };
  if (data.annulleret_kl || Date.parse(data.udloeber_kl) <= Date.now()) return { kode: "udloebet" };

  const { data: auth, error: authFejl } = await admin.auth.admin.getUserById(data.bruger_id);
  if (authFejl) throw new Error(`getUserById: ${authFejl.message}`);
  if (!auth.user?.email) return { kode: "ugyldig" };
  if (auth.user.last_sign_in_at) return { kode: "logget_ind" };

  // Kun til fejlsøgning (hvor mange gange linket er åbnet). Fejler det, går
  // det ikke ud over firmaet.
  const { error: opdFejl } = await admin
    .from("firma_velkomst_billetter")
    .update({ aabnet_antal: Math.min((data.aabnet_antal ?? 0) + 1, 1_000_000), sidst_aabnet_kl: new Date().toISOString() })
    .eq("id", data.id);
  if (opdFejl) console.error("firma_velkomst_billetter (åbnet):", opdFejl.message);
  return { kode: "ok", email: auth.user.email };
}
