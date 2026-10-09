"use server";

// Admin: forsendelser, der kræver opmærksomhed (forsendelser.kraever_opmaerksomhed,
// sat af fragtkoden - fx "afleveret, men ikke markeret sendt", en fejlet
// annullering eller en returneret pakke). Vises under fanen Fragt på
// /admin/handler. Ingen penge flyttes her.
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { UUID_RE } from "@/lib/moderationLog";
import { staffAfslutHaengendeClaim } from "@/lib/fragt/server";

class BrugerFejl extends Error {}

const GENERISK_FEJL = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const INHABIL = "Du kan ikke behandle en handel, hvor du selv er køber eller sælger.";

// Markerer forsendelsen som håndteret: markeringen fjernes, og noten (staffs
// tekst + forsendelsens forklaring) gemmes i medarbejder-loggen. Idempotent:
// kun en forsendelse, der stadig er markeret, ændres.
export async function fragtMarkerHaandteret(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const forsendelseId = String(formData.get("forsendelseId") ?? "");
    const aarsag = String(formData.get("aarsag") ?? "").trim();
    const { admin, userId: staffId } = await assertRole("medarbejder");
    if (!UUID_RE.test(forsendelseId)) throw new BrugerFejl("Forsendelsen findes ikke.");
    if (!aarsag) throw new BrugerFejl("Skriv, hvad du har gjort.");
    if (aarsag.length > 500) throw new BrugerFejl("Noten må højst være 500 tegn.");

    const { data: f, error } = await admin
      .from("forsendelser")
      .select("id, trade_id, opmaerksomhed_tekst, kraever_opmaerksomhed")
      .eq("id", forsendelseId)
      .maybeSingle<{ id: string; trade_id: string; opmaerksomhed_tekst: string | null; kraever_opmaerksomhed: boolean }>();
    if (error) throw new Error(error.message);
    if (!f) throw new BrugerFejl("Forsendelsen findes ikke.");
    if (!f.kraever_opmaerksomhed) return { ok: true };

    const { data: t } = await admin
      .from("trades")
      .select("buyer_id, seller_id")
      .eq("id", f.trade_id)
      .maybeSingle<{ buyer_id: string; seller_id: string }>();
    if (t && (t.buyer_id === staffId || t.seller_id === staffId)) throw new BrugerFejl(INHABIL);

    const { data: opdateret, error: opdFejl } = await admin
      .from("forsendelser")
      .update({ kraever_opmaerksomhed: false, opmaerksomhed_tekst: null })
      .eq("id", forsendelseId)
      .eq("kraever_opmaerksomhed", true)
      .select("id");
    if (opdFejl) throw new Error(opdFejl.message);
    // En anden medarbejder nåede det først.
    if (!opdateret || opdateret.length === 0) return { ok: true };

    const forklaring = (f.opmaerksomhed_tekst ?? "").slice(0, 400);
    const { error: logFejl } = await admin.from("moderation_log").insert({
      medarbejder_id: staffId,
      handling: "fragt_haandteret",
      maal_type: "handel",
      maal_id: f.trade_id,
      bruger_id: null,
      aarsag: forklaring ? `${aarsag} (Fragt: ${forklaring})` : aarsag,
    });
    if (logFejl) console.error("Kunne ikke skrive til moderation_log:", logFejl.message);

    revalidatePath("/admin/handler");
    revalidatePath("/admin");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    console.error("Admin-handling fragtMarkerHaandteret fejlede:", err);
    return { fejl: GENERISK_FEJL };
  }
}

// Afslutter en hængende fragtlabel (status 'opretter' efter ukendt udfald),
// efter staff har tjekket i Shipmondo:
//   valg=fejlet   intet er oprettet hos Shipmondo (note krævet) - sælgeren kan prøve igen.
//   valg=tilknyt  forsendelsen findes: shipmondoId = Shipmondos forsendelses-id
//                 (referencen skal være BidHamrs forsendelses-id).
// Logges i medarbejder-loggen. Knappen bygges af frontend (fanen Fragt på /admin/handler).
export async function fragtAfslutHaengendeLabel(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const forsendelseId = String(formData.get("forsendelseId") ?? "");
    const valg = String(formData.get("valg") ?? "");
    const note = String(formData.get("aarsag") ?? "").trim();
    const shipmondoId = String(formData.get("shipmondoId") ?? "").trim();
    const { admin, userId: staffId } = await assertRole("medarbejder");
    if (!UUID_RE.test(forsendelseId)) throw new BrugerFejl("Forsendelsen findes ikke.");
    if (valg !== "fejlet" && valg !== "tilknyt") throw new BrugerFejl("Vælg, hvad der skal ske.");
    if (!note) throw new BrugerFejl("Skriv, hvad du har tjekket i Shipmondo.");
    if (note.length > 500) throw new BrugerFejl("Noten må højst være 500 tegn.");
    if (valg === "tilknyt" && !/^\d{1,20}$/.test(shipmondoId)) throw new BrugerFejl("Skriv Shipmondos forsendelses-id (kun tal).");

    const { data: f } = await admin
      .from("forsendelser")
      .select("trade_id")
      .eq("id", forsendelseId)
      .maybeSingle<{ trade_id: string }>();
    if (!f) throw new BrugerFejl("Forsendelsen findes ikke.");
    const { data: t } = await admin
      .from("trades")
      .select("buyer_id, seller_id")
      .eq("id", f.trade_id)
      .maybeSingle<{ buyer_id: string; seller_id: string }>();
    if (t && (t.buyer_id === staffId || t.seller_id === staffId)) throw new BrugerFejl(INHABIL);

    const r = await staffAfslutHaengendeClaim(forsendelseId, valg, { note, forsendelsesId: shipmondoId || null });
    if ("fejl" in r) throw new BrugerFejl(r.fejl);

    const { error: logFejl } = await admin.from("moderation_log").insert({
      medarbejder_id: staffId,
      handling: "fragt_haandteret",
      maal_type: "handel",
      maal_id: r.tradeId,
      bruger_id: null,
      aarsag:
        valg === "tilknyt"
          ? `Hængende fragtlabel tilknyttet Shipmondo-forsendelse ${shipmondoId}: ${note}`
          : `Hængende fragtlabel markeret fejlet: ${note}`,
    });
    if (logFejl) console.error("Kunne ikke skrive til moderation_log:", logFejl.message);

    revalidatePath("/admin/handler");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    console.error("Admin-handling fragtAfslutHaengendeLabel fejlede:", err);
    return { fejl: GENERISK_FEJL };
  }
}

// Godkender én ekstra udgående fragtlabel på en handel (sælgeren har brugt de
// 2 tilladte - fx efter to annulleringer). Logges i medarbejder-loggen.
// Hvert klik giver én label mere; loggen viser hvem og hvorfor.
export async function fragtGodkendEkstraLabel(formData: FormData): Promise<{ ok: true } | { fejl: string }> {
  try {
    const tradeId = String(formData.get("tradeId") ?? "");
    const aarsag = String(formData.get("aarsag") ?? "").trim();
    const { admin, userId: staffId } = await assertRole("medarbejder");
    if (!UUID_RE.test(tradeId)) throw new BrugerFejl("Handlen findes ikke.");
    if (!aarsag) throw new BrugerFejl("Skriv, hvorfor sælgeren må lave en label mere.");
    if (aarsag.length > 500) throw new BrugerFejl("Noten må højst være 500 tegn.");

    const { data: t } = await admin
      .from("trades")
      .select("buyer_id, seller_id")
      .eq("id", tradeId)
      .maybeSingle<{ buyer_id: string; seller_id: string }>();
    if (!t) throw new BrugerFejl("Handlen findes ikke.");
    if (t.buyer_id === staffId || t.seller_id === staffId) throw new BrugerFejl(INHABIL);

    const { data: svar, error } = await admin.rpc("fragt_godkend_ekstra_label", { p_trade: tradeId });
    if (error) throw new Error(error.message);
    if (svar !== "ok") throw new BrugerFejl("Køberen har ikke valgt levering på handlen.");

    const { error: logFejl } = await admin.from("moderation_log").insert({
      medarbejder_id: staffId,
      handling: "fragt_haandteret",
      maal_type: "handel",
      maal_id: tradeId,
      bruger_id: null,
      aarsag: `Ekstra fragtlabel godkendt: ${aarsag}`,
    });
    if (logFejl) console.error("Kunne ikke skrive til moderation_log:", logFejl.message);

    revalidatePath("/admin/handler");
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof BrugerFejl) return { fejl: err.message };
    console.error("Admin-handling fragtGodkendEkstraLabel fejlede:", err);
    return { fejl: GENERISK_FEJL };
  }
}
