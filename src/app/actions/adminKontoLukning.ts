"use server";

// 3 advarsler = profilen lukkes permanent - men ALDRIG automatisk (Filip,
// 3. oktober 2026). Når en bruger når 3 advarsler (alle typer; påmindelser
// tæller ikke), opretter databasen et forslag (konto_lukning_forslag,
// status 'afventer'). Admin/chef godkender (lukning via
// bruger_luk_konto_permanent, inhabilitet gælder) eller afviser med
// begrundelse. Brugeren får først besked, når lukningen er godkendt.
//
// Fejl RETURNERES som { fejl } (Next skjuler kastede fejl i produktion).
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { assertRole, getStaffRole, harMindstRolle } from "@/lib/adminAuth";
import { notificerAdvarsler } from "@/lib/notifikationer/cron";

class BrugerFejl extends Error {}

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const INGEN_ADGANG = "Du har ikke adgang til at gøre dette.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function koer<T>(navn: string, fn: () => Promise<T>): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: INGEN_ADGANG };
    }
    console.error(`Kontolukning: ${navn} fejlede:`, err);
    return { fejl: GENERISK };
  }
}

const KODE_FEJL: Record<string, string> = {
  ingen_adgang: "Kun admin og chef kan godkende eller afvise lukning af en konto.",
  ikke_fundet: "Forslaget findes ikke.",
  behandlet: "Forslaget er allerede behandlet. Genindlæs siden.",
  begrundelse_mangler: "Skriv, hvorfor kontoen ikke skal lukkes.",
  for_lang_tekst: "Teksten er for lang (højst 2000 tegn).",
  sig_selv: "Du kan ikke behandle et forslag om din egen konto.",
  staff:
    "Brugeren er medarbejder, admin eller chef og kan ikke lukkes herfra. En chef skal fjerne rollen først – eller afvis forslaget.",
  inhabil: "Du kan ikke behandle denne bruger, fordi I har en sag med hinanden.",
  ugyldig_bruger: "Brugeren findes ikke.",
  aarsag_mangler: GENERISK,
};

function kodeFejl(kode: string | undefined): string {
  return KODE_FEJL[kode ?? ""] ?? GENERISK;
}

function tekst(formData: FormData, navn: string): string {
  const v = formData.get(navn);
  return typeof v === "string" ? v.trim() : "";
}

function revalider(brugerId?: string) {
  revalidatePath("/admin", "layout");
  revalidatePath("/admin/kontolukninger");
  if (brugerId) revalidatePath(`/admin/brugere/${brugerId}`);
}

// Badge i admin-menuen. Kun admin/chef ser et tal; medarbejdere får 0.
export async function hentAntalKontoLukninger() {
  return koer("hentAntalKontoLukninger", async () => {
    const rolle = await getStaffRole();
    if (!rolle || !harMindstRolle(rolle, "admin")) return { ok: true as const, antal: 0 };
    const { admin } = await assertRole("admin");
    const { count, error } = await admin
      .from("konto_lukning_forslag")
      .select("id", { count: "exact", head: true })
      .eq("status", "afventer");
    if (error) throw new Error(error.message);
    return { ok: true as const, antal: count ?? 0 };
  });
}

// formData: forslagId, note (intern, valgfri).
export async function godkendKontoLukning(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  return koer("godkendKontoLukning", async () => {
    const { admin, userId } = await assertRole("admin");
    const forslagId = tekst(formData, "forslagId");
    const note = tekst(formData, "note");
    if (!UUID.test(forslagId)) throw new BrugerFejl(KODE_FEJL.ikke_fundet);
    if (note.length > 2000) throw new BrugerFejl(KODE_FEJL.for_lang_tekst);

    const { data, error } = await admin.rpc("konto_lukning_godkend", {
      p_medarbejder: userId,
      p_forslag: forslagId,
      p_note: note || null,
    });
    if (error) throw new Error(error.message);
    const svar = (data ?? { kode: "" }) as { kode: string; bruger_id?: string };
    if (svar.kode === "bortfaldet") {
      revalider(svar.bruger_id);
      throw new BrugerFejl("Kontoen var allerede lukket. Forslaget er markeret som bortfaldet.");
    }
    if (svar.kode !== "ok") throw new BrugerFejl(kodeFejl(svar.kode));

    // Brugeren får besked om lukningen. Cron samler op, hvis det fejler.
    after(() => notificerAdvarsler());

    revalider(svar.bruger_id);
    revalidatePath("/admin/brugere");
    return { ok: true as const };
  });
}

// formData: forslagId, begrundelse (intern, påkrævet).
export async function afvisKontoLukning(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  return koer("afvisKontoLukning", async () => {
    const { admin, userId } = await assertRole("admin");
    const forslagId = tekst(formData, "forslagId");
    const begrundelse = tekst(formData, "begrundelse");
    if (!UUID.test(forslagId)) throw new BrugerFejl(KODE_FEJL.ikke_fundet);
    if (!begrundelse) throw new BrugerFejl(KODE_FEJL.begrundelse_mangler);
    if (begrundelse.length > 2000) throw new BrugerFejl(KODE_FEJL.for_lang_tekst);

    const { data, error } = await admin.rpc("konto_lukning_afvis", {
      p_medarbejder: userId,
      p_forslag: forslagId,
      p_begrundelse: begrundelse,
    });
    if (error) throw new Error(error.message);
    const svar = (data ?? { kode: "" }) as { kode: string; bruger_id?: string };
    if (svar.kode !== "ok") throw new BrugerFejl(kodeFejl(svar.kode));

    revalider(svar.bruger_id);
    return { ok: true as const };
  });
}
