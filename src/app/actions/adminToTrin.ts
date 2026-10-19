"use server";

// Admin → Medarbejdere: chefens "Nulstil to-trins-login" og "Åbn tilmelding
// (24 t)" (docs/ADMIN-VAERT.md). Kræver chef (assertRole - på admin-hosten
// med to-trins-login) OG en kode fra chefens app, der højst er 15 minutter
// gammel: er den seneste kode ældre, skal chefen skrive en ny i formularen.
// Chefen kan ikke nulstille sig selv (nødudgangen er SQL i Supabase - se
// docs/ADMIN-VAERT.md, "Låst ude af admin"). Databasen logger handlingen i
// moderation_log, og medarbejderen får en mail. Fejl RETURNERES.
import { revalidatePath } from "next/cache";
import { assertRole } from "@/lib/adminAuth";
import { adminVaertAktiv } from "@/lib/adminVaert";
import { createClient } from "@/lib/supabase/server";
import { graenseFejl, tjekGraenserLukket } from "@/lib/rateLimit";
import { aktivTotpFaktor, bekraeftTotp, sendSikkerhedsmail } from "@/lib/staffToTrin";
import { FRISK_KODE_MINUTTER, andetTrinFrisk } from "@/lib/staffToTrinRegler";
import { toTrinNulstilletMail, toTrinTilmeldingMail } from "@/lib/mails/staffToTrin";

type Svar = { ok: true } | { fejl: string; kodeKraeves?: true };

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ChefAdgang = Awaited<ReturnType<typeof assertRole>>;

// Chef + frisk kode. Uden ADMIN_VAERT findes to-trins-login ikke, og
// knapperne vises ikke.
async function chefMedFriskKode(kode: FormDataEntryValue | null): Promise<ChefAdgang | { fejl: string; kodeKraeves?: true }> {
  if (!adminVaertAktiv()) return { fejl: "To-trins-login er ikke slået til." };
  let adgang: ChefAdgang;
  try {
    adgang = await assertRole("chef");
  } catch {
    return { fejl: "Du har ikke adgang til at gøre dette." };
  }
  const graense = graenseFejl(await tjekGraenserLukket([["admin_to_trin_chef", adgang.userId]]));
  if (graense) return { fejl: graense };

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const nu = Math.floor(Date.now() / 1000);
  if (andetTrinFrisk(data?.claims?.amr, FRISK_KODE_MINUTTER * 60, nu)) return adgang;

  const tekst = typeof kode === "string" ? kode : "";
  if (!tekst.trim()) {
    return { fejl: `Skriv koden fra din app (kræves, når der er gået over ${FRISK_KODE_MINUTTER} minutter siden sidste kode).`, kodeKraeves: true };
  }
  const graenseKode = graenseFejl(await tjekGraenserLukket([["admin_kode_bruger", adgang.userId]]));
  if (graenseKode) return { fejl: graenseKode, kodeKraeves: true };
  const faktor = await aktivTotpFaktor(adgang.userId);
  if (!faktor) return { fejl: GENERISK };
  const svar = await bekraeftTotp(supabase, faktor, tekst);
  if (svar === "ugyldig") return { fejl: "Skriv de 6 cifre fra din app.", kodeKraeves: true };
  if (svar === "forkert") return { fejl: "Koden passer ikke. Prøv med den nye kode fra din app.", kodeKraeves: true };
  if (svar !== "ok") return { fejl: GENERISK };
  return adgang;
}

function maalId(formData: FormData): string | null {
  const id = String(formData.get("userId") ?? "").trim();
  return UUID.test(id) ? id : null;
}

export async function nulstilToTrin(formData: FormData): Promise<Svar> {
  try {
    const bruger = maalId(formData);
    if (!bruger) return { fejl: "Medarbejderen findes ikke." };
    const adgang = await chefMedFriskKode(formData.get("kode"));
    if ("fejl" in adgang) return adgang;
    if (bruger === adgang.userId) return { fejl: "Du kan ikke nulstille dit eget to-trins-login." };

    const { data, error } = await adgang.admin.rpc("staff_to_trin_nulstil", {
      p_chef: adgang.userId,
      p_bruger: bruger,
      p_timer: 24,
    });
    const r = data as { kode?: string; aaben_til?: string } | null;
    if (error || (r?.kode !== "ok" && r?.kode !== "uaendret")) {
      if (r?.kode === "egen") return { fejl: "Du kan ikke nulstille dit eget to-trins-login." };
      if (r?.kode === "ikke_fundet") return { fejl: "Medarbejderen findes ikke." };
      console.error("staff_to_trin_nulstil:", error?.message ?? r?.kode);
      return { fejl: GENERISK };
    }
    if (r.kode === "ok") {
      await sendSikkerhedsmail(
        bruger,
        toTrinNulstilletMail({ tidspunkt: new Date(), aabenTil: new Date(r.aaben_til ?? Date.now() + 24 * 3600 * 1000) }),
      );
    }
    revalidatePath("/admin/medarbejdere");
    return { ok: true };
  } catch (err) {
    console.error("nulstilToTrin kastede:", err);
    return { fejl: GENERISK };
  }
}

export async function aabnToTrinTilmelding(formData: FormData): Promise<Svar> {
  try {
    const bruger = maalId(formData);
    if (!bruger) return { fejl: "Medarbejderen findes ikke." };
    const adgang = await chefMedFriskKode(formData.get("kode"));
    if ("fejl" in adgang) return adgang;
    if (bruger === adgang.userId) return { fejl: "Du kan ikke åbne tilmelding for dig selv." };

    const { data, error } = await adgang.admin.rpc("staff_to_trin_aabn_tilmelding", {
      p_chef: adgang.userId,
      p_bruger: bruger,
      p_timer: 24,
    });
    const r = data as { kode?: string; aaben_til?: string } | null;
    if (error || r?.kode !== "ok") {
      if (r?.kode === "ikke_staff") return { fejl: "Giv personen en rolle først." };
      if (r?.kode === "egen") return { fejl: "Du kan ikke åbne tilmelding for dig selv." };
      console.error("staff_to_trin_aabn_tilmelding:", error?.message ?? r?.kode);
      return { fejl: GENERISK };
    }
    await sendSikkerhedsmail(
      bruger,
      toTrinTilmeldingMail({ aabenTil: new Date(r.aaben_til ?? Date.now() + 24 * 3600 * 1000) }),
    );
    revalidatePath("/admin/medarbejdere");
    return { ok: true };
  } catch (err) {
    console.error("aabnToTrinTilmelding kastede:", err);
    return { fejl: GENERISK };
  }
}
