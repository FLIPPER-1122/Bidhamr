"use server";

// Admin: DSA-anmeldelser og klager (/admin/dsa). Medarbejder og op; at fjerne
// en auktion eller lukke en konto kræver admin (som resten af admin).
// Rollen tjekkes her OG i databasefunktionerne (kun service_role).
// Fejl RETURNERES som { fejl }.

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole, getStaffRole } from "@/lib/adminAuth";
import { indgrebFejl, udfoerIndgreb } from "@/lib/dsa/server";
import { erUuid } from "@/lib/dsa/link";
import { notificerAnmeldelseSvar, notificerKlageSvar } from "@/lib/dsa/notifikationer";
import {
  erDsaHandling,
  erIndholdType,
  erRegel,
  handlingKraeverAdmin,
  handlingerFor,
} from "@/lib/dsa/regler";

class BrugerFejl extends Error {}

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

async function koer<T>(navn: string, fn: () => Promise<T>): Promise<T | { fejl: string }> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Du har ikke adgang til at gøre dette." };
    }
    console.error(`DSA-admin: ${navn} fejlede:`, err);
    return { fejl: GENERISK };
  }
}

function tekst(formData: FormData, navn: string): string {
  const v = formData.get(navn);
  return typeof v === "string" ? v.trim() : "";
}

function revalider() {
  revalidatePath("/admin/dsa");
  revalidatePath("/admin", "layout");
}

const KODE_FEJL: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang til at gøre dette.",
  ugyldigt_udfald: "Vælg et udfald.",
  svar_mangler: "Skriv et svar. Det sendes til den, der har anmeldt eller klaget.",
  note_mangler: "Skriv en note til admin om, hvorfor du videresender.",
  for_lang_tekst: "En af teksterne er for lang (højst 2000 tegn).",
  ikke_fundet: "Sagen findes ikke.",
  behandlet: "Sagen er allerede behandlet. Genindlæs siden.",
  inhabil:
    "Du kan ikke behandle denne sag, fordi du selv traf afgørelsen, er part, eller har handlet med brugeren. Lad en kollega tage den.",
  uaendret: "Sagen er allerede videresendt.",
};

// Tal til menuen: åbne anmeldelser og klager (og hvor mange der er over fristen).
export async function hentAntalDsa(): Promise<{ ok: true; antal: number; overskredet: number } | { fejl: string }> {
  return koer("hentAntalDsa", async () => {
    if (!(await getStaffRole())) return { ok: true as const, antal: 0, overskredet: 0 };
    const { admin } = await assertRole("medarbejder");
    const nu = new Date().toISOString();
    const [a, k, ao, ko] = await Promise.all([
      admin.from("dsa_anmeldelser").select("id", { count: "exact", head: true }).eq("status", "ny"),
      admin.from("dsa_klager").select("id", { count: "exact", head: true }).eq("status", "afventer"),
      admin.from("dsa_anmeldelser").select("id", { count: "exact", head: true }).eq("status", "ny").lt("frist_kl", nu),
      admin.from("dsa_klager").select("id", { count: "exact", head: true }).eq("status", "afventer").lt("frist_kl", nu),
    ]);
    // Mangler tabellerne (migrationen er ikke kørt), vises bare 0.
    const n = (r: { count: number | null; error: unknown }) => (r.error ? 0 : (r.count ?? 0));
    return { ok: true as const, antal: n(a) + n(k), overskredet: n(ao) + n(ko) };
  });
}

// Fjern/skjul/suspendér efter en anmeldelse.
// formData: anmeldelseId, handling, regel, fakta (til brugeren), aarsag
// (intern), svar (til anmelderen, valgfri), politi ('ja'), varighed.
export async function dsaIndgrebFraAnmeldelse(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  return koer("dsaIndgrebFraAnmeldelse", async () => {
    const anmeldelseId = tekst(formData, "anmeldelseId");
    const handling = tekst(formData, "handling");
    const regel = tekst(formData, "regel");
    const fakta = tekst(formData, "fakta");
    const varighed = tekst(formData, "varighed");
    if (!erUuid(anmeldelseId)) throw new BrugerFejl(KODE_FEJL.ikke_fundet);
    if (!erDsaHandling(handling)) throw new BrugerFejl("Vælg, hvad der skal gøres.");
    if (!erRegel(regel)) throw new BrugerFejl("Vælg hvilken regel eller lov, indholdet bryder.");
    if (!fakta) throw new BrugerFejl("Skriv en begrundelse til brugeren: hvad har brugeren gjort?");

    const { admin, userId } = await assertRole(handlingKraeverAdmin(handling) ? "admin" : "medarbejder");
    const { data: a } = await admin
      .from("dsa_anmeldelser")
      .select("indhold_type, indhold_id, status")
      .eq("id", anmeldelseId)
      .maybeSingle<{ indhold_type: string; indhold_id: string | null; status: string }>();
    if (!a) throw new BrugerFejl(KODE_FEJL.ikke_fundet);
    if (a.status !== "ny") throw new BrugerFejl(KODE_FEJL.behandlet);
    if (!a.indhold_id || !erIndholdType(a.indhold_type) || !handlingerFor(a.indhold_type).includes(handling)) {
      throw new BrugerFejl("Det indgreb passer ikke til det anmeldte indhold.");
    }

    const r = await udfoerIndgreb(admin, {
      staffId: userId,
      type: a.indhold_type,
      id: a.indhold_id,
      handling,
      regel,
      fakta,
      internNote: tekst(formData, "aarsag") || null,
      anmeldelseId,
      svarTilAnmelder: tekst(formData, "svar") || null,
      politiUnderrettet: formData.get("politi") === "ja",
      varighed: varighed === "1" || varighed === "7" || varighed === "permanent" ? varighed : undefined,
    });
    if (!r.ok) throw new BrugerFejl(indgrebFejl(r.kode));
    revalider();
    revalidatePath("/admin/auktioner");
    revalidatePath("/admin/bedommelser");
    return { ok: true as const };
  });
}

// Behold indholdet (ingen overtrædelse) eller luk som "ikke fundet".
// formData: anmeldelseId, udfald, svar (til anmelderen), aarsag (intern), politi.
export async function dsaAnmeldelseAfgoer(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  return koer("dsaAnmeldelseAfgoer", async () => {
    const { admin, userId } = await assertRole("medarbejder");
    const id = tekst(formData, "anmeldelseId");
    if (!erUuid(id)) throw new BrugerFejl(KODE_FEJL.ikke_fundet);
    const { data, error } = await admin.rpc("dsa_anmeldelse_afgoer", {
      p_medarbejder: userId,
      p_anmeldelse: id,
      p_udfald: tekst(formData, "udfald"),
      p_svar: tekst(formData, "svar"),
      p_intern_note: tekst(formData, "aarsag") || null,
      p_politi: formData.get("politi") === "ja",
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") throw new BrugerFejl(KODE_FEJL[kode ?? ""] ?? GENERISK);
    after(() => notificerAnmeldelseSvar(id));
    revalider();
    return { ok: true as const };
  });
}

// Videresend til admin. formData: anmeldelseId, aarsag (note, påkrævet).
export async function dsaVideresend(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  return koer("dsaVideresend", async () => {
    const { admin, userId } = await assertRole("medarbejder");
    const id = tekst(formData, "anmeldelseId");
    if (!erUuid(id)) throw new BrugerFejl(KODE_FEJL.ikke_fundet);
    const { data, error } = await admin.rpc("dsa_anmeldelse_videresend", {
      p_medarbejder: userId,
      p_anmeldelse: id,
      p_note: tekst(formData, "aarsag"),
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") throw new BrugerFejl(KODE_FEJL[kode ?? ""] ?? GENERISK);
    revalider();
    return { ok: true as const };
  });
}

// Afgør en klage. Rollen afhænger af det oprindelige indgreb og tjekkes i
// databasen (dsa_klage_afgoer), som også håndhæver inhabilitet.
// formData: klageId, udfald ('medhold' | 'fastholdt'), svar, aarsag (intern).
export async function dsaKlageAfgoer(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  return koer("dsaKlageAfgoer", async () => {
    const { admin, userId } = await assertRole("medarbejder");
    const id = tekst(formData, "klageId");
    if (!erUuid(id)) throw new BrugerFejl(KODE_FEJL.ikke_fundet);
    const { data, error } = await admin.rpc("dsa_klage_afgoer", {
      p_medarbejder: userId,
      p_klage: id,
      p_udfald: tekst(formData, "udfald"),
      p_svar: tekst(formData, "svar"),
      p_intern_note: tekst(formData, "aarsag") || null,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") {
      if (kode === "ingen_adgang") {
        throw new BrugerFejl("Klager over fjernede auktioner og lukkede konti skal behandles af en admin eller chef.");
      }
      throw new BrugerFejl(KODE_FEJL[kode ?? ""] ?? indgrebFejl(kode ?? ""));
    }
    after(() => notificerKlageSvar(id));
    revalider();
    revalidatePath("/admin/auktioner");
    revalidatePath("/admin/bedommelser");
    revalidatePath("/admin/brugere");
    return { ok: true as const };
  });
}
