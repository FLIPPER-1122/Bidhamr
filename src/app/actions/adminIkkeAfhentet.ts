"use server";

// Admin: staff markerer en handel som "ikke afhentet" - fragtfirmaet har
// sendt pakken retur til sælgeren, fordi køberen ikke hentede den
// (ROADMAP-BESLUTNINGER afsnit 1, model 3). Bruges, når fragtfirmaets signal
// ikke er sikkert nok til at gøre det automatisk (fx Shipmondo), eller når
// staff kender udfaldet fra fragtfirmaet.
//
// Samme vej som fragtens automatik (src/lib/betaling/ikkeAfhentet.ts ->
// handel_ikke_afhentet_registrer): handlen annulleres, køberen refunderes
// købsbeløbet minus gebyrer og fragt begge veje, sælgeren får intet udbetalt
// og beholder varen. Medarbejder, admin og chef må (som ved sager, hvor
// pengene flyttes). Inhabil = køber eller sælger på handlen. Begrundelsen er
// krævet og logges i medarbejder-loggen.
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { UUID_RE } from "@/lib/moderationLog";
import { IKKE_AFHENTET_FEJL, registrerIkkeAfhentet } from "@/lib/betaling/ikkeAfhentet";
import { REFUSION_I_GANG, REFUSION_KONFLIKT } from "@/lib/betaling/refusionTekster";

class BrugerFejl extends Error {}

const GENERISK_FEJL = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const INHABIL = "Du kan ikke behandle en handel, hvor du selv er køber eller sælger. Bed en kollega om det.";
const BEGRUNDELSE_MAKS = 1000;

// formData: tradeId, aarsag (begrundelse - krævet), forsendelseId (valgfri).
export async function handelIkkeAfhentet(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const tradeId = String(formData.get("tradeId") ?? "").trim();
    const forsendelseRaa = String(formData.get("forsendelseId") ?? "").trim();
    const aarsag = String(formData.get("aarsag") ?? "").trim();
    const { admin, userId: staffId } = await assertRole("medarbejder");
    if (!UUID_RE.test(tradeId)) throw new BrugerFejl("Handlen findes ikke.");
    if (forsendelseRaa && !UUID_RE.test(forsendelseRaa)) throw new BrugerFejl("Forsendelsen findes ikke.");
    if (!aarsag) throw new BrugerFejl("Skriv en begrundelse.");
    if (aarsag.length > BEGRUNDELSE_MAKS) {
      throw new BrugerFejl(`Begrundelsen må højst være ${BEGRUNDELSE_MAKS} tegn.`);
    }

    // Inhabilitet tjekkes også i databasen (under lås).
    const { data: t, error: tFejl } = await admin
      .from("trades")
      .select("buyer_id, seller_id")
      .eq("id", tradeId)
      .maybeSingle<{ buyer_id: string; seller_id: string }>();
    if (tFejl) throw new Error(tFejl.message);
    if (!t) throw new BrugerFejl("Handlen findes ikke.");
    if (t.buyer_id === staffId || t.seller_id === staffId) throw new BrugerFejl(INHABIL);

    const svar = await registrerIkkeAfhentet({
      tradeId,
      kilde: "staff",
      medarbejderId: staffId,
      begrundelse: aarsag,
      forsendelseId: forsendelseRaa || null,
      refunderNu: true,
    });

    if (svar.kode === "allerede") {
      throw new BrugerFejl("Handlen er allerede registreret som ikke afhentet.");
    }
    if (svar.kode !== "ok" && svar.kode !== "ok_intet") {
      throw new BrugerFejl(IKKE_AFHENTET_FEJL[svar.kode] ?? GENERISK_FEJL);
    }

    // Handlen er annulleret, og refusionen er claimet: log altid (ingen beløb
    // i loggen - pengetal er kun for chef).
    const udfald =
      svar.kode === "ok_intet"
        ? `Køberen får 0 kr. (returfragten er mindst buddet) - sælgerens del tilbageføres (${svar.refusion ?? "sat i gang"})`
        : `Tilbagebetaling minus gebyrer og fragt begge veje (${svar.refusion ?? "sat i gang"})`;
    const { error: logFejl } = await admin.from("moderation_log").insert({
      medarbejder_id: staffId,
      handling: "handel_ikke_afhentet",
      maal_type: "handel",
      maal_id: tradeId,
      bruger_id: t.buyer_id,
      aarsag: `${udfald} — ${aarsag}`,
    });
    if (logFejl) console.error("Kunne ikke skrive til moderation_log:", logFejl.message);

    revalidatePath("/admin", "layout");
    revalidatePath(`/mine-handler/${tradeId}`);

    if (svar.refusion === "refusion_konflikt") throw new BrugerFejl(REFUSION_KONFLIKT);
    if (svar.refusion === "refusion_i_gang") throw new BrugerFejl(REFUSION_I_GANG);
    if (svar.refusion === "fejlet") {
      throw new BrugerFejl(
        "Handlen er annulleret, men tilbagebetalingen (eller tilbageførslen fra sælgeren) fejlede hos Stripe. Den prøves igen automatisk - følg den under Betalinger.",
      );
    }
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    console.error("Admin-handling handelIkkeAfhentet fejlede:", err);
    return { fejl: GENERISK_FEJL };
  }
}
