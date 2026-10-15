"use server";

// Admin -> brugeren -> Boost-point (kun chef): justér en brugers point med
// begrundelse, og refundér et køb af point. Databasen tjekker rollen igen
// (boost_staff_justering / boost_staff_refusion), afviser chefens egen konto
// og logger i moderation_log. Saldoen kan aldrig blive negativ.

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { staffRefunderBoostKoeb } from "@/lib/betaling/boost";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const tekst = (f: FormData, n: string) => ((f.get(n) as string | null) ?? "").trim();

const JUSTERING_FEJL: Record<string, string> = {
  ingen_adgang: "Kun chefen kan justere point.",
  inhabil: "Du kan ikke justere dine egne point.",
  begrundelse_mangler: "Skriv en begrundelse.",
  ugyldig: "Skriv et helt antal point mellem -10.000 og 10.000 (ikke 0).",
  ikke_fundet: "Brugeren findes ikke.",
};

export async function justerBoostPoint(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  let staffId: string | null = null;
  try {
    const { userId, admin } = await assertRole("chef");
    staffId = userId;
    const bruger = tekst(formData, "brugerId");
    const noegle = tekst(formData, "noegle");
    const begrundelse = tekst(formData, "begrundelse");
    const pointTekst = tekst(formData, "point").replace(/\s/g, "").replace("−", "-");
    if (!UUID.test(bruger) || !UUID.test(noegle)) return { fejl: "Ugyldig forespørgsel." };
    if (!/^[+-]?\d{1,5}$/.test(pointTekst)) return { fejl: JUSTERING_FEJL.ugyldig };
    const point = Number(pointTekst);
    if (!begrundelse) return { fejl: JUSTERING_FEJL.begrundelse_mangler };
    const { data, error } = await admin.rpc("boost_staff_justering", {
      p_staff: userId,
      p_bruger: bruger,
      p_point: point,
      p_begrundelse: begrundelse.slice(0, 1000),
      p_noegle: noegle,
    });
    if (error) throw new Error(`boost_staff_justering: ${error.message}`);
    const s = data as { kode?: string; saldo?: number } | null;
    revalidatePath(`/admin/brugere/${bruger}`);
    if (s?.kode === "ok" || s?.kode === "allerede") return { ok: true };
    if (s?.kode === "for_lav_saldo") {
      return { fejl: `Brugeren har kun ${s.saldo ?? 0} point - saldoen kan ikke blive negativ.` };
    }
    return { fejl: JUSTERING_FEJL[s?.kode ?? ""] ?? GENERISK };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Ingen adgang." };
    }
    await logDriftFejl({ kilde: "action", sti: "admin", hvor: "Boost: justér point", fejl: err, brugerId: staffId });
    return { fejl: GENERISK };
  }
}

export async function refunderBoostKoebAction(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  let staffId: string | null = null;
  try {
    const { userId } = await assertRole("chef");
    staffId = userId;
    const koeb = tekst(formData, "koebId");
    const bruger = tekst(formData, "brugerId");
    const begrundelse = tekst(formData, "begrundelse");
    if (!UUID.test(koeb)) return { fejl: "Købet findes ikke." };
    if (!begrundelse) return { fejl: "Skriv en begrundelse." };
    const r = await staffRefunderBoostKoeb(userId, koeb, begrundelse.slice(0, 1000));
    if (UUID.test(bruger)) revalidatePath(`/admin/brugere/${bruger}`);
    if ("fejl" in r) return r;
    if (r.kode === "refunderet" || r.kode === "allerede") return { ok: true };
    // Claimet, pointene er trukket, og det er logget - men Stripe svarede
    // ikke: cron'en prøver igen.
    return { fejl: "Refusionen er bestilt, men Stripe svarede ikke. Den prøves igen automatisk – opdatér siden om lidt." };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Ingen adgang." };
    }
    await logDriftFejl({ kilde: "action", sti: "admin", hvor: "Boost: refundér køb", fejl: err, brugerId: staffId });
    return { fejl: GENERISK };
  }
}
