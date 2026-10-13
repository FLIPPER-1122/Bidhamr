"use server";

// Admin → sagen: "Refundér returfragt" (returfragt i sager,
// src/lib/betaling/returfragt.ts). Kun admin og chef. Databasen
// (returfragt_staff_refusion) tjekker rolle og inhabilitet igen, kræver, at
// der ikke er en aktiv returkode (en annulleret er ok), og logger i
// moderation_log. Hele returfragten refunderes til køberen hos Stripe.

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { staffRefunderReturfragt } from "@/lib/betaling/returfragt";
import { logDriftFejl } from "@/lib/drift";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function refunderReturfragtAction(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  let staffId: string | null = null;
  try {
    const { userId } = await assertRole("admin");
    staffId = userId;
    const id = ((formData.get("returfragtId") as string | null) ?? "").trim();
    const begrundelse = ((formData.get("begrundelse") as string | null) ?? "").trim();
    if (!UUID.test(id)) return { fejl: "Returfragten findes ikke." };
    if (!begrundelse) return { fejl: "Skriv en begrundelse." };
    const r = await staffRefunderReturfragt(userId, id, begrundelse.slice(0, 1000));
    revalidatePath("/admin", "layout");
    if ("fejl" in r) return r;
    if (r.kode === "refunderet" || r.kode === "allerede") return { ok: true };
    // Claimet og logget, men Stripe-kaldet fejlede: cron'en prøver igen.
    return { fejl: "Refusionen er bestilt, men Stripe svarede ikke. Den prøves igen automatisk – tjek Betalinger om lidt." };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Ingen adgang." };
    }
    await logDriftFejl({ kilde: "action", sti: "admin", hvor: "Refundér returfragt", fejl: err, brugerId: staffId });
    return { fejl: "Noget gik galt. Prøv igen, eller kontakt en udvikler." };
  }
}
