"use server";

// Admin → Erhverv → Klager over afgørelser: chef og sælger-rollen afgør
// DSA-klager over suspension og lukning af en FIRMAKONTO (Filip, 10. okt.
// 2026: de kan gøre alt ved firmaer). Adgangen tjekkes her (assertErhverv),
// og kun klager over en firmakonto accepteres. Databasen afgør resten
// (dsa_klage_afgoer, 20261016050000): rolle, inhabilitet, ophævelse og log.
// Klageren får besked som i det almindelige DSA-flow. Fejl RETURNERES som { fejl }.
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertErhverv } from "@/lib/adminAuth";
import { erUuid } from "@/lib/dsa/link";
import { indgrebFejl } from "@/lib/dsa/server";
import { hentFirmaDsaKlage } from "@/lib/dsa/firmaKlager";
import { notificerKlageSvar } from "@/lib/dsa/notifikationer";
import { logDriftFejl } from "@/lib/drift";

class BrugerFejl extends Error {}

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

const KODE_FEJL: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang til at afgøre denne klage.",
  ugyldigt_udfald: "Vælg et udfald.",
  svar_mangler: "Skriv et svar. Det sendes til den, der har klaget.",
  for_lang_tekst: "En af teksterne er for lang (højst 2000 tegn).",
  ikke_fundet: "Klagen findes ikke.",
  behandlet: "Klagen er allerede afgjort. Genindlæs siden.",
  inhabil:
    "Du kan ikke behandle denne klage, fordi du selv traf afgørelsen, har klaget, har anmeldt, er part eller har handlet med firmaet. Lad en kollega tage den.",
};

function tekst(formData: FormData, navn: string): string {
  const v = formData.get(navn);
  return typeof v === "string" ? v.trim() : "";
}

// formData: klageId, udfald ('medhold' | 'fastholdt'), svar, aarsag (intern).
export async function erhvervDsaKlageAfgoer(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const { admin, userId } = await assertErhverv();
    const id = tekst(formData, "klageId");
    const udfald = tekst(formData, "udfald");
    if (!erUuid(id)) throw new BrugerFejl(KODE_FEJL.ikke_fundet);
    if (udfald !== "medhold" && udfald !== "fastholdt") throw new BrugerFejl(KODE_FEJL.ugyldigt_udfald);

    // Kun klager over suspension/lukning af en firmakonto. Alt andet hører
    // til DSA → Klager (medarbejder og op).
    const klage = await hentFirmaDsaKlage(admin, id);
    if (!klage) throw new BrugerFejl("Klagen handler ikke om en firmakonto. Den behandles under DSA → Klager.");

    const { data, error } = await admin.rpc("dsa_klage_afgoer", {
      p_medarbejder: userId,
      p_klage: id,
      p_udfald: udfald,
      p_svar: tekst(formData, "svar"),
      p_intern_note: tekst(formData, "aarsag") || null,
    });
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok") throw new BrugerFejl(KODE_FEJL[kode ?? ""] ?? indgrebFejl(kode ?? ""));

    after(() => notificerKlageSvar(id));
    revalidatePath("/admin/erhverv/dsa-klager");
    revalidatePath(`/admin/erhverv/dsa-klager/${id}`);
    revalidatePath("/admin/erhverv/firmaer");
    revalidatePath("/admin/dsa");
    revalidatePath("/admin/brugere");
    revalidatePath("/admin", "layout");
    return { ok: true as const };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Du har ikke adgang til at gøre dette." };
    }
    console.error("erhvervDsaKlageAfgoer fejlede:", err);
    await logDriftFejl({ kilde: "action", hvor: "adminErhvervDsa.erhvervDsaKlageAfgoer", fejl: err });
    return { fejl: GENERISK };
  }
}
