"use server";

// Admin -> brugeren -> Seller founder (KUN chef): gør en privat bruger til
// founder med en startdato, ret startdatoen og stop aftalen. Databasen tjekker
// rollen igen (seller_founder_opret/_ret_start/_stop i
// 20261102420000_seller_founder.sql), afviser firmakonti og chefens egen
// konto og logger hver hændelse i moderation_log. Rabatten låses på hver
// betaling, når den oprettes - en ændring her påvirker kun nye betalinger.

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATO = /^\d{4}-\d{2}-\d{2}$/;
const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const tekst = (f: FormData, n: string) => ((f.get(n) as string | null) ?? "").trim();

const FEJL: Record<string, string> = {
  ingen_adgang: "Kun chefen kan ændre seller founder-aftaler.",
  inhabil: "Du kan ikke gøre dig selv til seller founder.",
  ikke_fundet: "Brugeren findes ikke.",
  firma: "Firmakonti kan ikke være seller founder.",
  allerede: "Brugeren er allerede seller founder.",
  ikke_founder: "Brugeren har ingen aktiv seller founder-aftale.",
  ugyldig_dato: "Vælg en gyldig startdato (fra 2026 og højst et år frem).",
  ugyldig: "Ugyldig forespørgsel. Noten må højst være 1.000 tegn.",
};

type Svar = { ok: true } | { fejl: string };

function gyldigDato(s: string): boolean {
  if (!DATO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

async function kald(
  hvor: string,
  formData: FormData,
  rpc: (bruger: string, chef: string) => { navn: string; args: Record<string, unknown> } | { fejl: string },
): Promise<Svar> {
  let staffId: string | null = null;
  try {
    const { userId, admin } = await assertRole("chef");
    staffId = userId;
    const bruger = tekst(formData, "brugerId");
    if (!UUID.test(bruger)) return { fejl: FEJL.ugyldig };
    const k = rpc(bruger, userId);
    if ("fejl" in k) return k;
    const { data, error } = await admin.rpc(k.navn, k.args);
    if (error) throw new Error(`${k.navn}: ${error.message}`);
    const kode = (data as { kode?: string } | null)?.kode ?? "";
    revalidatePath(`/admin/brugere/${bruger}`);
    revalidatePath("/admin/brugere/founders");
    if (kode === "ok" || kode === "uaendret") return { ok: true };
    return { fejl: FEJL[kode] ?? GENERISK };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Ingen adgang." };
    }
    await logDriftFejl({ kilde: "action", sti: "admin", hvor: `Seller founder: ${hvor}`, fejl: err, brugerId: staffId });
    return { fejl: GENERISK };
  }
}

export async function opretSellerFounder(formData: FormData): Promise<Svar> {
  return kald("opret", formData, (bruger, chef) => {
    const start = tekst(formData, "startDato");
    const note = tekst(formData, "note");
    if (!gyldigDato(start)) return { fejl: FEJL.ugyldig_dato };
    if (note.length > 1000) return { fejl: FEJL.ugyldig };
    return {
      navn: "seller_founder_opret",
      args: { p_chef: chef, p_bruger: bruger, p_start: start, p_note: note || null },
    };
  });
}

export async function retSellerFounderStart(formData: FormData): Promise<Svar> {
  return kald("ret startdato", formData, (bruger, chef) => {
    const start = tekst(formData, "startDato");
    if (!gyldigDato(start)) return { fejl: FEJL.ugyldig_dato };
    return { navn: "seller_founder_ret_start", args: { p_chef: chef, p_bruger: bruger, p_start: start } };
  });
}

export async function stopSellerFounder(formData: FormData): Promise<Svar> {
  return kald("stop", formData, (bruger, chef) => {
    const begrundelse = tekst(formData, "begrundelse").slice(0, 1000);
    return {
      navn: "seller_founder_stop",
      args: { p_chef: chef, p_bruger: bruger, p_begrundelse: begrundelse || null },
    };
  });
}
