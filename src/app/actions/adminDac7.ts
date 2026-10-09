"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { lavIndberetningsfil, markerIndberetningSendt } from "@/lib/dac7/server";

// Admin → DAC7 (KUN chef): indstillinger, indberetningsfil og "Sendt til
// Skattestyrelsen". Rollen tjekkes her OG i databasen (dac7_er_chef).
// Indberetningsfilen indeholder CPR-numre: den bygges i hukommelsen og
// sendes kun til chefens browser - den gemmes ingen steder.

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

const KODER: Record<string, string> = {
  ingen_adgang: "Kun chefen kan gøre det.",
  ugyldig: "Tjek felterne: CVR 8 cifre, postnummer 4 cifre.",
  ugyldig_kurs: "Kursen skal være et tal mellem 1 og 100 (DKK pr. EUR), fx 7,46.",
  allerede_sendt: "Året er allerede markeret som sendt til Skattestyrelsen.",
  aaret_er_ikke_slut: "Året er ikke slut endnu - indberetningen laves efter nytår.",
  kvittering_mangler: "Skriv kvitteringsnummeret fra TastSelv Erhverv.",
  platform_mangler: "Udfyld BidHamrs CVR-nummer under Indstillinger først.",
  eksport_mangler: "Vælg den fil (eksport), du har uploadet til Skattestyrelsen.",
  eksport_for_tidlig:
    "Filen er hentet, før året var slut, og mangler derfor salg. Hent en ny fil, upload den, og vælg den her.",
  hash_forkert:
    "Den valgte fil passer ikke med eksporten. Vælg præcis den fil, du hentede her og uploadede i TastSelv Erhverv.",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function aarFra(v: FormDataEntryValue | null): number | null {
  const n = Number(String(v ?? ""));
  return Number.isInteger(n) && n >= 2023 && n <= 2100 ? n : null;
}

export async function gemDac7Indstillinger(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const { userId, admin } = await assertRole("chef");
    const aar = aarFra(formData.get("aar"));
    if (!aar) return { fejl: KODER.ugyldig };
    const kursTekst = String(formData.get("kurs") ?? "").trim().replace(",", ".");
    const kurs = kursTekst === "" ? null : Number(kursTekst);
    if (kurs !== null && !Number.isFinite(kurs)) return { fejl: KODER.ugyldig_kurs };
    const t = (k: string, maks: number) => String(formData.get(k) ?? "").trim().slice(0, maks);
    const { data, error } = await admin.rpc("dac7_admin_gem_indstillinger", {
      p_medarbejder: userId,
      p_aar: aar,
      p_kurs: kurs,
      p_cvr: t("cvr", 8),
      p_navn: t("navn", 200),
      p_vej: t("vej", 200),
      p_postnummer: t("postnummer", 4),
      p_bynavn: t("bynavn", 100),
      p_kontakt: t("kontakt", 200),
    });
    if (error) throw new Error(`dac7_admin_gem_indstillinger: ${error.code ?? "ukendt"}`);
    const kode = (data as { kode?: string } | null)?.kode ?? "fejl";
    if (kode !== "ok") return { fejl: KODER[kode] ?? GENERISK };
    revalidatePath("/admin/dac7");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    console.error("gemDac7Indstillinger fejlede:", err);
    return { fejl: GENERISK };
  }
}

export async function hentDac7Indberetningsfil(
  aar: number,
): Promise<{ ok: true; fil: string; filnavn: string; antal: number; ufuldstaendige: number; ulaeselige: number } | { fejl: string }> {
  try {
    const { userId } = await assertRole("chef");
    if (!Number.isInteger(aar) || aar < 2023 || aar > 2100) return { fejl: KODER.ugyldig };
    return await lavIndberetningsfil(userId, aar);
  } catch (err) {
    unstable_rethrow(err);
    await logDriftFejl({ kilde: "server", sti: "/admin/dac7", hvor: "DAC7: indberetningsfil", fejl: err });
    return { fejl: GENERISK };
  }
}

export async function markerDac7Sendt(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const { userId } = await assertRole("chef");
    const aar = aarFra(formData.get("aar"));
    if (!aar) return { fejl: KODER.ugyldig };
    const kvittering = String(formData.get("kvittering") ?? "").trim().slice(0, 200);
    const eksportId = String(formData.get("eksport") ?? "");
    const hash = String(formData.get("hash") ?? "").toLowerCase();
    if (!UUID.test(eksportId)) return { fejl: KODER.eksport_mangler };
    if (!/^[0-9a-f]{64}$/.test(hash)) return { fejl: KODER.hash_forkert };
    const res = await markerIndberetningSendt(userId, aar, eksportId, hash, kvittering);
    if (!("ok" in res)) return { fejl: KODER[res.kode] ?? GENERISK };
    revalidatePath("/admin/dac7");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    await logDriftFejl({ kilde: "server", sti: "/admin/dac7", hvor: "DAC7: markér sendt", fejl: err });
    return { fejl: GENERISK };
  }
}
