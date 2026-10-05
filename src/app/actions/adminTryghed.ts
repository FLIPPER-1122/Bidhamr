"use server";

// Admin: rapporter af chatbeskeder/brugere (bruger_rapporter) og
// henvendelser fra kontaktformularen (kontakt_henvendelser). Medarbejder og
// op. Statusskift er idempotente (update ... where status = ...). Intet
// slettes. Fejl RETURNERES som { fejl }.

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole, getStaffRole } from "@/lib/adminAuth";

class BrugerFejl extends Error {}

const GENERISK_FEJL = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function koer<T>(navn: string, fn: () => Promise<T>): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    console.error(`Admin-handling ${navn} fejlede:`, err);
    return { fejl: GENERISK_FEJL };
  }
}

function tekst(formData: FormData, navn: string): string {
  return String(formData.get(navn) ?? "").trim();
}

// --- Tal til menuen ----------------------------------------------------------

export async function hentAntalTryghed(): Promise<
  { ok: true; kontakt: number; rapporter: number } | { fejl: string }
> {
  return koer("hentAntalTryghed", async () => {
    if (!(await getStaffRole())) return { ok: true as const, kontakt: 0, rapporter: 0 };
    const { admin } = await assertRole("medarbejder");
    const [kontakt, brugerRapporter, opslag] = await Promise.all([
      admin.from("kontakt_henvendelser").select("id", { count: "exact", head: true }).eq("status", "ny"),
      admin.from("bruger_rapporter").select("id", { count: "exact", head: true }).eq("status", "ny"),
      admin.from("reports").select("id", { count: "exact", head: true }).eq("status", "pending"),
    ]);
    // Mangler tabellerne (migrationen er ikke kørt endnu), vises bare 0.
    return {
      ok: true as const,
      kontakt: kontakt.error ? 0 : (kontakt.count ?? 0),
      rapporter:
        (brugerRapporter.error ? 0 : (brugerRapporter.count ?? 0)) +
        (opslag.error ? 0 : (opslag.count ?? 0)),
    };
  });
}

// --- Rapporter af beskeder/brugere -------------------------------------------

// formData: rapportId, aarsag (note, påkrævet).
export async function brugerRapportBehandlet(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  return koer("brugerRapportBehandlet", async () => {
    const { admin, userId } = await assertRole("medarbejder");
    const id = tekst(formData, "rapportId");
    const note = tekst(formData, "aarsag");
    if (!UUID.test(id)) throw new BrugerFejl("Rapporten findes ikke.");
    if (!note) throw new BrugerFejl("Skriv en note om, hvad du har tjekket, og hvad konklusionen er.");
    if (note.length > 2000) throw new BrugerFejl("Noten må højst være 2000 tegn.");
    const { data, error } = await admin
      .from("bruger_rapporter")
      .update({
        status: "behandlet",
        handled_by: userId,
        handled_at: new Date().toISOString(),
        handled_note: note,
      })
      .eq("id", id)
      .eq("status", "ny")
      .select("id");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new BrugerFejl("Rapporten er allerede behandlet.");
    revalidatePath("/admin/bruger-rapporter");
    return { ok: true as const };
  });
}

// formData: rapportId.
export async function brugerRapportGenaabn(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  return koer("brugerRapportGenaabn", async () => {
    const { admin } = await assertRole("medarbejder");
    const id = tekst(formData, "rapportId");
    if (!UUID.test(id)) throw new BrugerFejl("Rapporten findes ikke.");
    // Noten og hvem der behandlede bevares som historik, indtil den behandles igen.
    const { error } = await admin
      .from("bruger_rapporter")
      .update({ status: "ny" })
      .eq("id", id)
      .eq("status", "behandlet");
    if (error) throw new Error(error.message);
    revalidatePath("/admin/bruger-rapporter");
    return { ok: true as const };
  });
}

// --- Kontaktformular ---------------------------------------------------------

// formData: henvendelseId.
export async function kontaktMarkerBesvaret(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  return koer("kontaktMarkerBesvaret", async () => {
    const { admin, userId } = await assertRole("medarbejder");
    const id = tekst(formData, "henvendelseId");
    if (!UUID.test(id)) throw new BrugerFejl("Henvendelsen findes ikke.");
    const { error } = await admin
      .from("kontakt_henvendelser")
      .update({ status: "besvaret", besvaret_af: userId, besvaret_kl: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "ny");
    if (error) throw new Error(error.message);
    revalidatePath("/admin/kontakt");
    return { ok: true as const };
  });
}

// formData: henvendelseId.
export async function kontaktGenaabn(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  return koer("kontaktGenaabn", async () => {
    const { admin } = await assertRole("medarbejder");
    const id = tekst(formData, "henvendelseId");
    if (!UUID.test(id)) throw new BrugerFejl("Henvendelsen findes ikke.");
    const { error } = await admin
      .from("kontakt_henvendelser")
      .update({ status: "ny" })
      .eq("id", id)
      .eq("status", "besvaret");
    if (error) throw new Error(error.message);
    revalidatePath("/admin/kontakt");
    return { ok: true as const };
  });
}
