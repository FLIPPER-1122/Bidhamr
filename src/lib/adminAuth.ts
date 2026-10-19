import "server-only";

// Må KUN importeres i server-kode (server components/actions) — returnerer
// service-role-klienten, som aldrig må ende i klient-bundlen.
//
// Al adgang til admin går gennem hentStaffAdgang() (Filip, 19. okt. 2026 -
// docs/ADMIN-VAERT.md). Med ADMIN_VAERT sat kræves:
//   (a) forespørgslen er på admin-hosten (Host-headeren, src/lib/adminVaert.ts),
//   (b) sessionen er aal2, og koden fra app'en (amr 'totp') er højst
//       STAFF_TO_TRIN_MAKS_TIMER gammel (standard 12 timer),
//   (c) databasen (min_staff_adgang) siger aktiv og ingen ukendte faktorer,
//   (d) rollen.
// Uden ADMIN_VAERT gælder kun rollen - som før, uden to-trins-krav.
// assertRole/kraevSideRolle/getStaffRole og Erhverv-udgaverne er tynde lag
// ovenpå, så alle eksisterende admin-sider og -actions får kravet uden at
// blive rørt.
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, paaAdminVaert } from "@/lib/supabase/server";
import { hentBruger, hentMinRolle } from "@/lib/supabase/bruger";
import { adminUrl, adminVaertAktiv } from "@/lib/adminVaert";
import {
  toTrinMaksTimer,
  vurderStaffAdgang,
  type StaffAfvisning,
  type StaffDb,
  type StaffRolle,
} from "@/lib/staffToTrinRegler";

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

// --- Fælles adgangstjek -----------------------------------------------------

export type StaffAdgangOk = {
  ok: true;
  userId: string;
  // Alle staff-roller, også 'saelger' (kun Erhverv).
  rolle: StaffRolle;
  // Seneste kode fra app'en (sekunder siden 1970) - null uden ADMIN_VAERT.
  andetTrinSek: number | null;
};
export type StaffAdgangSvar = StaffAdgangOk | { ok: false; grund: StaffAfvisning };

// JWT-claims (verificeret med projektets offentlige nøgle). aal og amr bruges
// til (b). Delt i hele forespørgslen.
const hentClaims = cache(async (): Promise<Record<string, unknown> | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;
  return data.claims as Record<string, unknown>;
});

const hentStaffDb = cache(async (): Promise<StaffDb | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("min_staff_adgang");
  if (error) {
    console.error("min_staff_adgang fejlede:", error.code, error.message);
    return null;
  }
  const d = (data ?? {}) as { staff?: unknown; aktiv?: unknown; ukendte_faktorer?: unknown };
  return { aktiv: d.staff === true && d.aktiv === true, ukendte_faktorer: d.ukendte_faktorer === true };
});

// Bruger, rolle, host, JWT og databasen - højst én gang pr. forespørgsel i
// sider (cache()); i server actions spørges der på ny ved hvert kald.
export const hentStaffAdgang = cache(async (): Promise<StaffAdgangSvar> => {
  const flagAktiv = adminVaertAktiv();
  const [user, minRolle, vaert] = await Promise.all([hentBruger(), hentMinRolle(), paaAdminVaert()]);
  const medToTrin = flagAktiv && vaert && !!user;
  const [claims, db] = medToTrin ? await Promise.all([hentClaims(), hentStaffDb()]) : [null, null];
  const v = vurderStaffAdgang({
    flagAktiv,
    paaAdminVaert: vaert,
    brugerId: user?.id ?? null,
    claimsSub: typeof claims?.sub === "string" ? claims.sub : null,
    rolle: minRolle,
    aal: claims?.aal,
    amr: claims?.amr,
    db,
    nuSek: Math.floor(Date.now() / 1000),
    maksTimer: toTrinMaksTimer(),
  });
  if (!v.ok) return v;
  return { ok: true, userId: user!.id, rolle: v.rolle, andetTrinSek: v.andetTrinSek };
});

// Hvor en admin-SIDE sender hen ved en afvisning (GET). Next-afbrydelser
// (redirect/notFound) logges ikke som fejl i drift_fejl.
function afvisSide(grund: StaffAfvisning): never {
  switch (grund) {
    case "ikke_logget_ind":
      redirect(adminVaertAktiv() ? adminUrl("/adgang/login") : "/");
    case "forkert_vaert":
      // Hovedsitet med ADMIN_VAERT sat: admin ligger på admin-hosten.
      redirect(adminUrl("/admin"));
    case "kraever_kode":
    case "ukendt_faktor":
      redirect("/adgang/kode");
    case "ikke_opsat":
      redirect("/adgang/opsaet");
    case "fejl":
      throw new Error("Adgangen til admin kunne ikke tjekkes (min_staff_adgang)");
    default:
      notFound();
  }
}

function afvisAction(grund: StaffAfvisning): never {
  if (grund === "ikke_logget_ind") throw new Error("Ikke logget ind");
  if (grund === "kraever_kode" || grund === "ukendt_faktor" || grund === "ikke_opsat") {
    throw new Error("Kræver to-trins-login");
  }
  throw new Error("Ingen adgang");
}

type StaffAdgang = {
  userId: string;
  rolle: StaffRole;
  admin: ReturnType<typeof createAdminClient>;
  andetTrinSek: number | null;
};

async function hentAdgang(min: StaffRole): Promise<StaffAdgang | { grund: StaffAfvisning }> {
  const s = await hentStaffAdgang();
  if (!s.ok) return { grund: s.grund };
  const rolle = somStaffRole(s.rolle);
  if (!rolle || !harMindstRolle(rolle, min)) return { grund: "ingen_adgang" };
  return { userId: s.userId, rolle, admin: createAdminClient(), andetTrinSek: s.andetTrinSek };
}

// Til layout/sider: brugerens staff-rolle (medarbejder/admin/chef) eller null.
// Med ADMIN_VAERT sat er svaret null uden for admin-hosten - staff-UI på
// hovedsitet er erstattet af links til admin (adminUrl).
export async function getStaffRole(): Promise<StaffRole | null> {
  const s = await hentStaffAdgang();
  return s.ok ? somStaffRole(s.rolle) : null;
}

// Til server actions. Kaster en almindelig fejl ved manglende adgang, som
// actions fanger og laver om til en { fejl }-besked. Returnerer
// service-role-klienten til læs/skriv — RLS-policies dækker ikke
// admin-operationer på andres rækker.
export async function assertRole(min: StaffRole): Promise<StaffAdgang> {
  const res = await hentAdgang(min);
  if ("grund" in res) afvisAction(res.grund);
  return res;
}

// Til admin-SIDER (server components). Samme tjek som assertRole, men viser en
// pæn afvisning: login/kode-siden på admin-hosten (eller forsiden uden
// ADMIN_VAERT), manglende rolle giver "Siden findes ikke" (admin/not-found.tsx).
export async function kraevSideRolle(min: StaffRole): Promise<StaffAdgang> {
  const res = await hentAdgang(min);
  if ("grund" in res) afvisSide(res.grund);
  return res;
}

// --- Erhverv (chef + sælger) -------------------------------------------------
// Rollen 'saelger' står UDEN FOR hierarkiet medarbejder < admin < chef:
// getStaffRole/assertRole/kraevSideRolle kender den ikke og giver den derfor
// ingen adgang til resten af admin. Erhverv i admin kræver 'chef' eller
// 'saelger'; pakker og priser kun 'chef'. Databasen tjekker det samme igen
// (erhverv_har_adgang i 20261010030000_erhverv.sql). Samme to-trins-krav som
// resten af admin (hentStaffAdgang).

export type ErhvervRolle = "chef" | "saelger";

function somErhvervRolle(rolle: unknown): ErhvervRolle | null {
  return rolle === "chef" || rolle === "saelger" ? rolle : null;
}

export async function getErhvervRolle(): Promise<ErhvervRolle | null> {
  const s = await hentStaffAdgang();
  return s.ok ? somErhvervRolle(s.rolle) : null;
}

type ErhvervAdgang = {
  userId: string;
  rolle: ErhvervRolle;
  admin: ReturnType<typeof createAdminClient>;
};

async function hentErhvervAdgang(kunChef: boolean): Promise<ErhvervAdgang | { grund: StaffAfvisning }> {
  const s = await hentStaffAdgang();
  if (!s.ok) return { grund: s.grund };
  const rolle = somErhvervRolle(s.rolle);
  if (!rolle || (kunChef && rolle !== "chef")) return { grund: "ingen_adgang" };
  return { userId: s.userId, rolle, admin: createAdminClient() };
}

// Til server actions under Erhverv. kunChef: pakker og priser.
export async function assertErhverv(kunChef = false): Promise<ErhvervAdgang> {
  const res = await hentErhvervAdgang(kunChef);
  if ("grund" in res) afvisAction(res.grund);
  return res;
}

// Til admin-sider under Erhverv (som kraevSideRolle).
export async function kraevErhvervSide(kunChef = false): Promise<ErhvervAdgang> {
  const res = await hentErhvervAdgang(kunChef);
  if ("grund" in res) afvisSide(res.grund);
  return res;
}

// --- Visning på hovedsitet ----------------------------------------------------
// Rollen fra databasen KUN til at vise et "Åbn i admin"-link eller en
// forklarende tekst på hovedsitet (fx auktionssiden). Giver aldrig adgang til
// noget: alle staff-handlinger går gennem assertRole ovenfor.
export async function staffRolleTilVisning(): Promise<StaffRolle | null> {
  const [user, minRolle] = await Promise.all([hentBruger(), hentMinRolle()]);
  if (!user) return null;
  return minRolle === "chef" || minRolle === "admin" || minRolle === "medarbejder" || minRolle === "saelger"
    ? minRolle
    : null;
}
