"use server";

// "Tag sagen" på almindelige sager (Filip, 12. okt. 2026): så to staff ikke
// arbejder på den samme sag. Databasen (sag_tag / sag_slip i
// 20261020010000_admin_hurtig.sql) tjekker rolle og inhabilitet igen og
// logger i moderation_log. Ingen penge flyttes, og ingen får besked.
// Fejl RETURNERES som { fejl }.

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { adminSagSti } from "@/lib/sager";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";

const KODE: Record<string, string> = {
  ikke_fundet: "Sagen findes ikke.",
  afsluttet: "Sagen er afgjort og kan ikke tages.",
  inhabil: "Du er inhabil: du er selv køber eller sælger i handlen.",
  ikke_din: "Kun den, der har sagen, eller en admin kan slippe den.",
};

type Svar = { ok: true } | { fejl: string; taget?: { navn: string | null; kl: string | null } };

async function koer(navn: string, fn: () => Promise<Svar>): Promise<Svar> {
  try {
    return await fn();
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: "Du har ikke adgang til at gøre dette." };
    }
    console.error(`${navn} fejlede:`, err);
    return { fejl: GENERISK };
  }
}

function mangler(e: { code?: string } | null) {
  return !!e && ["PGRST202", "42883"].includes(e.code ?? "");
}

export async function tagSag(sagId: string, overtag = false): Promise<Svar> {
  return koer("tagSag", async () => {
    const { admin, userId } = await assertRole("medarbejder");
    if (!UUID.test(sagId)) return { fejl: KODE.ikke_fundet };
    const { data, error } = await admin.rpc("sag_tag", { p_medarbejder: userId, p_sag: sagId, p_overtag: overtag === true });
    if (mangler(error)) return { fejl: "\"Tag sagen\" kræver migrationen 20261020010000_admin_hurtig.sql." };
    if (error) throw new Error(error.message);
    const svar = (data ?? {}) as { kode?: string; af_navn?: string | null; kl?: string | null };
    if (svar.kode === "taget") {
      return { fejl: `Sagen er taget af ${svar.af_navn ?? "en kollega"}.`, taget: { navn: svar.af_navn ?? null, kl: svar.kl ?? null } };
    }
    if (svar.kode !== "ok" && svar.kode !== "uaendret") return { fejl: KODE[svar.kode ?? ""] ?? GENERISK };
    revalidatePath("/admin/sager");
    revalidatePath(adminSagSti(sagId));
    return { ok: true };
  });
}

export async function slipSag(sagId: string): Promise<Svar> {
  return koer("slipSag", async () => {
    const { admin, userId } = await assertRole("medarbejder");
    if (!UUID.test(sagId)) return { fejl: KODE.ikke_fundet };
    const { data, error } = await admin.rpc("sag_slip", { p_medarbejder: userId, p_sag: sagId });
    if (mangler(error)) return { fejl: "\"Tag sagen\" kræver migrationen 20261020010000_admin_hurtig.sql." };
    if (error) throw new Error(error.message);
    const kode = (data as { kode?: string } | null)?.kode;
    if (kode !== "ok" && kode !== "uaendret") return { fejl: KODE[kode ?? ""] ?? GENERISK };
    revalidatePath("/admin/sager");
    revalidatePath(adminSagSti(sagId));
    return { ok: true };
  });
}
