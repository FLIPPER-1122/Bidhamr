"use server";

// Admin -> Henvendelser -> BidHamr-bot (kun chef): døgnlofterne i
// bot_indstillinger (én række, kun service-role). Databasen tjekker
// grænserne igen (bot_indstillinger_vaerdier). Hver ændring logges i
// moderation_log ('bot_lofter_aendret', gamle og nye værdier) af en trigger
// i samme transaktion (20261102410000) - med opdateret_af som medarbejder.

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { laesBotIndstillinger } from "@/lib/bot/konfig";

const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

export async function gemBotIndstillinger(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  let staffId: string | null = null;
  try {
    const { userId, admin } = await assertRole("chef");
    staffId = userId;
    const v = laesBotIndstillinger({
      doegnloft_usd: formData.get("doegnloft_usd"),
      anon_procent: formData.get("anon_procent"),
      bruger_loft_usd: formData.get("bruger_loft_usd"),
      doegnloft_anon: formData.get("doegnloft_anon"),
    });
    if ("fejl" in v) return v;
    const { data, error } = await admin
      .from("bot_indstillinger")
      .update({ ...v, opdateret_kl: new Date().toISOString(), opdateret_af: userId })
      .eq("id", true)
      .select("id");
    if (error) throw new Error(`bot_indstillinger: ${error.code ?? ""} ${error.message}`);
    if (!data || data.length === 0) throw new Error("bot_indstillinger: rækken findes ikke");
    revalidatePath("/admin/bot");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Kun chefen kan ændre lofterne." };
    }
    await logDriftFejl({ kilde: "action", sti: "/admin/bot", hvor: "BidHamr-bot: gem lofter", fejl: err, brugerId: staffId });
    return { fejl: GENERISK };
  }
}
