import "server-only";

// Månedlig oprydning af dokumentationsfiler for ekstra fragt (Filip, 21. okt.
// 2026): filer i bucket'en 'ekstra-fragt-dokumentation', som ingen regning
// bruger, og som er over 7 dage gamle (fx en upload, staff ikke gjorde
// færdig). Listen kommer fra ekstra_fragt_ubrugte_filer
// (20261029020000_ekstra_fragt.sql); sletningen sker via Storage-API'et, så
// filen også forsvinder fra lageret. Dokumentation, en regning bruger,
// slettes aldrig (handelsdata).
//
// Kaldes af hovedcron'en (/api/cron/afslut-auktioner), men kører kun den 1. i
// måneden (dansk tid) og kun én gang pr. måned (rate limit med måneden som
// nøgle). Måneden markeres som kørt FØRST, når oprydningen er lykkedes - en
// fejl prøves igen ved næste cron-kørsel. Fejl logges i drift_fejl af kalderen. Antallet slettede står i
// cron-resultatet og i serverloggen.
import { createAdminClient } from "@/lib/supabase/admin";
import { graenseLedig, indenForGraense } from "@/lib/rateLimit";
import { EKSTRA_FRAGT_BUCKET } from "@/lib/betaling/ekstraFragt";

const PR_KOERSEL = 1000;
const PR_SLETNING = 100;

// "YYYY-MM-DD" i dansk tid.
function danskDato(nu: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(nu);
}

// Skal oprydningen køre i dag? Den 1. i måneden (dansk tid). Ren funktion (test).
export function erOprydningsdag(nu: Date = new Date()): boolean {
  return danskDato(nu).endsWith("-01");
}

// null = ikke i dag (eller allerede kørt denne måned).
export async function koerEkstraFragtOprydning(nu: Date = new Date()): Promise<{ slettet: number } | null> {
  if (!erOprydningsdag(nu)) return null;
  const maaned = danskDato(nu).slice(0, 7);
  // Kun et kig: tæller ikke op (markeres nederst, når det er lykkedes).
  if (!(await graenseLedig("ekstra_fragt_oprydning", maaned))) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("ekstra_fragt_ubrugte_filer", { p_graense: PR_KOERSEL });
  if (error) {
    // Migrationen er ikke kørt endnu.
    if (error.code === "PGRST202" || error.code === "42883") return null;
    throw new Error(`ekstra_fragt_ubrugte_filer: ${error.message}`);
  }
  const stier = ((data ?? []) as unknown[]).filter((s): s is string => typeof s === "string");
  let slettet = 0;
  for (let i = 0; i < stier.length; i += PR_SLETNING) {
    const del = stier.slice(i, i + PR_SLETNING);
    const { data: ud, error: sletFejl } = await admin.storage.from(EKSTRA_FRAGT_BUCKET).remove(del);
    if (sletFejl) throw new Error(`Ubrugte dokumentationsfiler (ekstra fragt) kunne ikke slettes: ${sletFejl.message} (${slettet} slettet før fejlen)`);
    slettet += (ud ?? []).length;
  }
  // Lykkedes: måneden er kørt.
  await indenForGraense("ekstra_fragt_oprydning", maaned);
  console.log(`Ekstra fragt: månedlig oprydning slettede ${slettet} ubrugte dokumentationsfiler (${maaned}).`);
  return { slettet };
}
