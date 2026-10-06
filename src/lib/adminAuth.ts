import "server-only";

// Må KUN importeres i server-kode (server components/actions) — returnerer
// service-role-klienten, som aldrig må ende i klient-bundlen.
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUserMedToTrin, harToTrin } from "@/lib/mfa";

// Medarbejdere SKAL have to-trins-login (verificeret TOTP-faktor) for at bruge
// admin og staff-handlinger. Har de det, kræves aal2 (getUserMedToTrin).
// Nødudgang: sæt STAFF_KRAEVER_TO_TRIN=false (Vercel/.env), hvis kravet låser
// nogen ude. Alt andet end præcis "false" betyder, at kravet er slået til.
export function staffKraeverToTrin(): boolean {
  return process.env.STAFF_KRAEVER_TO_TRIN !== "false";
}

// Hertil sendes en medarbejder uden to-trins-login (Min konto > Sikkerhed).
export const TO_TRIN_PAAKRAEVET_STI = "/konto?sikkerhed=to-trin-paakraevet";

// true, når brugeren skal sendes til opsætning af to-trins-login i stedet
// for at få staff-adgang.
export function manglerStaffToTrin(user: Parameters<typeof harToTrin>[0]): boolean {
  return staffKraeverToTrin() && !harToTrin(user);
}

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
  // Mangler to-trins-koden (aal1), er man ikke staff endnu.
  const {
    data: { user },
  } = await getUserMedToTrin(supabase);
  if (!user) return null;

  // rolle er ikke laesbar via kolonne-grants; min_rolle() udleder brugeren af auth.uid().
  const { data: minRolle } = await supabase.rpc("min_rolle");

  // Uden to-trins-login er man ikke staff (se staffKraeverToTrin).
  if (manglerStaffToTrin(user)) return null;
  return somStaffRole(minRolle);
}

type StaffAdgang = {
  userId: string;
  rolle: StaffRole;
  admin: ReturnType<typeof createAdminClient>;
};

async function hentAdgang(
  min: StaffRole,
): Promise<StaffAdgang | "ikke_logget_ind" | "ingen_adgang" | "mangler_to_trin"> {
  const supabase = await createClient();
  // Mangler to-trins-koden (aal1), er man ikke staff endnu.
  const {
    data: { user },
  } = await getUserMedToTrin(supabase);
  if (!user) return "ikke_logget_ind";

  // rolle er ikke laesbar via kolonne-grants; min_rolle() udleder brugeren af auth.uid().
  const { data: minRolle } = await supabase.rpc("min_rolle");

  const rolle = somStaffRole(minRolle);
  if (!rolle || !harMindstRolle(rolle, min)) return "ingen_adgang";
  if (manglerStaffToTrin(user)) return "mangler_to_trin";

  return { userId: user.id, rolle, admin: createAdminClient() };
}

// Til server actions. Kaster en almindelig fejl ved manglende adgang, som
// actions fanger og laver om til en { fejl }-besked. Returnerer
// service-role-klienten til læs/skriv — RLS-policies dækker ikke
// admin-operationer på andres rækker.
export async function assertRole(min: StaffRole): Promise<StaffAdgang> {
  const res = await hentAdgang(min);
  if (res === "ikke_logget_ind") throw new Error("Ikke logget ind");
  if (res === "ingen_adgang") throw new Error("Ingen adgang");
  if (res === "mangler_to_trin") {
    throw new Error("Medarbejdere skal bruge to-trins-login. Slå det til under Min konto.");
  }
  return res;
}

// Til admin-SIDER (server components). Samme tjek som assertRole, men viser en
// pæn afvisning i stedet for fejlsiden: ikke logget ind sendes til forsiden,
// manglende rolle giver "Siden findes ikke" (admin/not-found.tsx). Begge er
// Next-afbrydelser (NEXT_REDIRECT / NEXT_HTTP_ERROR_FALLBACK) og logges ikke
// som fejl i drift_fejl.
export async function kraevSideRolle(min: StaffRole): Promise<StaffAdgang> {
  const res = await hentAdgang(min);
  if (res === "ikke_logget_ind") redirect("/");
  if (res === "ingen_adgang") notFound();
  if (res === "mangler_to_trin") redirect(TO_TRIN_PAAKRAEVET_STI);
  return res;
}
