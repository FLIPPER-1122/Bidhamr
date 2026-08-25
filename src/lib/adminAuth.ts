// Må KUN importeres i server-kode (server components/actions) — returnerer
// service-role-klienten, som aldrig må ende i klient-bundlen.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type StaffRole = "medarbejder" | "admin" | "chef";

// Hierarki: medarbejder < admin < chef. assertRole(min) tillader min og opefter.
const ROLE_LEVEL: Record<StaffRole, number> = {
  medarbejder: 1,
  admin: 2,
  chef: 3,
};

export function harMindstRolle(rolle: StaffRole, min: StaffRole) {
  return ROLE_LEVEL[rolle] >= ROLE_LEVEL[min];
}

function somStaffRole(rolle: unknown): StaffRole | null {
  return rolle === "chef" || rolle === "admin" || rolle === "medarbejder"
    ? rolle
    : null;
}

// Til layout/sider: returnerer brugerens staff-rolle eller null.
export async function getStaffRole(): Promise<StaffRole | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("users")
    .select("rolle")
    .eq("id", user.id)
    .single();

  return somStaffRole(data?.rolle);
}

// Til server actions og admin-only sider. Returnerer service-role-klienten til
// læs/skriv — RLS-policies dækker ikke admin-operationer på andres rækker.
export async function assertRole(min: StaffRole) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Ikke logget ind");

  const { data } = await supabase
    .from("users")
    .select("rolle")
    .eq("id", user.id)
    .single();

  const rolle = somStaffRole(data?.rolle);
  if (!rolle || !harMindstRolle(rolle, min)) throw new Error("Ingen adgang");

  return { userId: user.id, rolle, admin: createAdminClient() };
}
