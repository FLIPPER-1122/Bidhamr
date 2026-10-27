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
// gamle annulleres), eller når firmaet har logget ind (så bruges "Glemt
// adgangskode"). Kun sha256-hashen gemmes i databasen.

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

export type VelkomstOpslag =
  | { kode: "ok"; email: string }
  | { kode: "ugyldig" | "udloebet" | "logget_ind" };

// Slår billetten op (forbruger den ikke). "ok": billetten gælder, og firmaet
// har aldrig logget ind - så må der laves et frisk Supabase-link.
export async function slaaVelkomstBilletOp(admin: Admin, billet: string): Promise<VelkomstOpslag> {
  if (!erVelkomstBillet(billet)) return { kode: "ugyldig" };
  const { data, error } = await admin
    .from("firma_velkomst_billetter")
    .select("id, bruger_id, udloeber_kl, annulleret_kl, aabnet_antal")
    .eq("token_hash", hash(billet))
    .maybeSingle<{ id: string; bruger_id: string; udloeber_kl: string; annulleret_kl: string | null; aabnet_antal: number }>();
  if (tabelMangler(error)) return { kode: "ugyldig" };
  if (error) throw new Error(`firma_velkomst_billetter: ${error.message}`);
  if (!data) return { kode: "ugyldig" };
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
