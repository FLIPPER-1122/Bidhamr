import "server-only";

// Må KUN importeres i server-kode (server components/actions) — returnerer
// service-role-klienten, som aldrig må ende i klient-bundlen.
import { notFound, redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { hentBruger, hentMinRolle } from "@/lib/supabase/bruger";

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
// Bruger og rolle hentes samtidig og højst én gang pr. forespørgsel
// (src/lib/supabase/bruger.ts). min_rolle() udleder brugeren af auth.uid() i
// JWT'en, og rollen bruges kun, hvis getUser også har godkendt brugeren.
export async function getStaffRole(): Promise<StaffRole | null> {
  const [user, minRolle] = await Promise.all([hentBruger(), hentMinRolle()]);
  if (!user) return null;
  return somStaffRole(minRolle);
}

type StaffAdgang = {
  userId: string;
  rolle: StaffRole;
  admin: ReturnType<typeof createAdminClient>;
};

async function hentAdgang(
  min: StaffRole,
): Promise<StaffAdgang | "ikke_logget_ind" | "ingen_adgang"> {
  // rolle er ikke laesbar via kolonne-grants; min_rolle() udleder brugeren af
  // auth.uid(). Hentes samtidig med getUser, men bruges kun, hvis getUser har
  // godkendt brugeren. I server actions er cache() uden virkning, så hvert
  // assertRole-kald spørger Supabase på ny.
  const [user, minRolle] = await Promise.all([hentBruger(), hentMinRolle()]);
  if (!user) return "ikke_logget_ind";

  const rolle = somStaffRole(minRolle);
  if (!rolle || !harMindstRolle(rolle, min)) return "ingen_adgang";

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
  return res;
}

// --- Erhverv (chef + sælger) -------------------------------------------------
// Rollen 'saelger' står UDEN FOR hierarkiet medarbejder < admin < chef:
// getStaffRole/assertRole/kraevSideRolle kender den ikke og giver den derfor
// ingen adgang til resten af admin. Erhverv i admin kræver 'chef' eller
// 'saelger'; pakker og priser kun 'chef'. Databasen tjekker det samme igen
// (erhverv_har_adgang i 20261010030000_erhverv.sql).

export type ErhvervRolle = "chef" | "saelger";

function somErhvervRolle(rolle: unknown): ErhvervRolle | null {
  return rolle === "chef" || rolle === "saelger" ? rolle : null;
}

export async function getErhvervRolle(): Promise<ErhvervRolle | null> {
  const [user, minRolle] = await Promise.all([hentBruger(), hentMinRolle()]);
  if (!user) return null;
  return somErhvervRolle(minRolle);
}

type ErhvervAdgang = {
  userId: string;
  rolle: ErhvervRolle;
  admin: ReturnType<typeof createAdminClient>;
};

async function hentErhvervAdgang(
  kunChef: boolean,
): Promise<ErhvervAdgang | "ikke_logget_ind" | "ingen_adgang"> {
  const [user, minRolle] = await Promise.all([hentBruger(), hentMinRolle()]);
  if (!user) return "ikke_logget_ind";
  const rolle = somErhvervRolle(minRolle);
  if (!rolle || (kunChef && rolle !== "chef")) return "ingen_adgang";
  return { userId: user.id, rolle, admin: createAdminClient() };
}

// Til server actions under Erhverv. kunChef: pakker og priser.
export async function assertErhverv(kunChef = false): Promise<ErhvervAdgang> {
  const res = await hentErhvervAdgang(kunChef);
  if (res === "ikke_logget_ind") throw new Error("Ikke logget ind");
  if (res === "ingen_adgang") throw new Error("Ingen adgang");
  return res;
}

// Til admin-sider under Erhverv (som kraevSideRolle).
export async function kraevErhvervSide(kunChef = false): Promise<ErhvervAdgang> {
  const res = await hentErhvervAdgang(kunChef);
  if (res === "ikke_logget_ind") redirect("/");
  if (res === "ingen_adgang") notFound();
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
  return res;
}
