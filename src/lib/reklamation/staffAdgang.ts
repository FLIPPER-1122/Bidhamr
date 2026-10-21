import "server-only";

// Inhabilitet for staff på en reklamation: samme regel som databasen
// (fragt_reklamation_tjek -> penge_inhabil: part i handlen eller har handlet
// med en af parterne). En inhabil medarbejder må hverken se pakken (købers
// kontaktoplysninger, billeder, intern note) eller hente ZIP'en - samme
// mønster som erhvervsklager. Fejler opslaget, regnes staff som inhabil
// (fail closed). Kalderen har tjekket rollen (kraevSideRolle/assertRole).
import type { createAdminClient } from "@/lib/supabase/admin";
import { erInhabil } from "@/lib/admin/sagTaget";

type Admin = ReturnType<typeof createAdminClient>;

export type ReklamationStaffAdgang = "ok" | "inhabil" | "ikke_fundet";

export async function reklamationStaffAdgang(admin: Admin, mig: string, reklamationId: string): Promise<ReklamationStaffAdgang> {
  const { data: r, error } = await admin
    .from("fragt_reklamationer")
    .select("trade_id")
    .eq("id", reklamationId)
    .maybeSingle<{ trade_id: string }>();
  if (error) throw new Error(`Reklamationen kunne ikke hentes: ${error.message}`);
  if (!r) return "ikke_fundet";
  const { data: t, error: tFejl } = await admin
    .from("trades")
    .select("buyer_id, seller_id")
    .eq("id", r.trade_id)
    .maybeSingle<{ buyer_id: string | null; seller_id: string | null }>();
  if (tFejl) throw new Error(`Handlen kunne ikke hentes: ${tFejl.message}`);
  return (await erInhabil(admin, mig, t?.buyer_id ?? null, t?.seller_id ?? null)) ? "inhabil" : "ok";
}
