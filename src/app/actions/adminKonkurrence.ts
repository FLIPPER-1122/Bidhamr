"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { erMaaned, GRUNDE_NY_VINDER, type GrundNyVinder } from "@/lib/konkurrence/regler";
import { giVinderBesked } from "@/lib/konkurrence/vinderBesked";
import { KONKURRENCE_ADMIN } from "@/lib/tekster/konkurrence";

// Admin → Konkurrence (KUN chef): træk månedens vinder og træk en ny vinder.
// Rollen tjekkes her OG i databasen (konkurrence_er_chef). Seedet laves af
// databasen i samme transaktion som trækningen (32 kryptografisk tilfældige
// bytes) og gemmes sammen med den fastfrosne liste, så trækningen kan
// efterregnes (20261023020000_badge_konkurrence.sql). Hverken chefen eller
// serveren kan vælge det. Databasen sørger for, at et dobbeltklik ikke giver
// to trækninger.
//
// Så snart der er trukket en vinder (også en ny vinder), får vinderen
// automatisk en samtale med BidHamr, en notifikation og en mail med
// svarfristen på 14 dage (src/lib/konkurrence/vinderBesked.ts - præcis én gang
// pr. trækning). Ingen vinder: ingen besked. En fejl i beskeden gør ikke
// trækningen til en fejl - chefen kan sende igen (sendVinderBesked).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Svar = { ok: true } | { fejl: string };

function svarFraKode(kode: string | undefined): Svar {
  if (kode === "ok") return { ok: true };
  return { fejl: (kode && KONKURRENCE_ADMIN.koder[kode]) || KONKURRENCE_ADMIN.generisk };
}

type TraekSvar = { kode?: string; traekning_id?: string; vinder_id?: string } | null;

// Kun når databasen har trukket en vinder lige nu (kode 'ok' med vinder).
// 'findes', 'allerede_erstattet' o.l. (dobbeltklik) sender ikke igen.
async function beskedTilNyVinder(admin: Parameters<typeof giVinderBesked>[0], chefId: string, svar: TraekSvar) {
  if (svar?.kode !== "ok" || !svar.vinder_id || !svar.traekning_id || !UUID.test(svar.traekning_id)) return;
  await giVinderBesked(admin, chefId, svar.traekning_id);
}

export async function traekVinder(formData: FormData): Promise<Svar> {
  try {
    const { userId, admin } = await assertRole("chef");
    const maaned = String(formData.get("maaned") ?? "");
    if (!erMaaned(maaned)) return { fejl: KONKURRENCE_ADMIN.koder.ugyldig_maaned };
    const { data, error } = await admin.rpc("konkurrence_traek", {
      p_chef: userId,
      p_maaned: maaned,
    });
    if (error) throw new Error(`konkurrence_traek: ${error.code ?? "ukendt"} ${error.message}`);
    await beskedTilNyVinder(admin, userId, data as TraekSvar);
    revalidatePath("/admin/konkurrence");
    return svarFraKode((data as TraekSvar)?.kode);
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: KONKURRENCE_ADMIN.koder.ingen_adgang };
    }
    await logDriftFejl({ kilde: "server", sti: "/admin/konkurrence", hvor: "Konkurrence: træk vinder", fejl: err });
    return { fejl: KONKURRENCE_ADMIN.generisk };
  }
}

export async function traekNyVinder(formData: FormData): Promise<Svar> {
  try {
    const { userId, admin } = await assertRole("chef");
    const traekning = String(formData.get("traekning") ?? "");
    const grund = String(formData.get("grund") ?? "") as GrundNyVinder;
    const begrundelse = String(formData.get("begrundelse") ?? "").trim();
    if (!UUID.test(traekning)) return { fejl: KONKURRENCE_ADMIN.koder.findes_ikke };
    if (!GRUNDE_NY_VINDER.includes(grund)) return { fejl: KONKURRENCE_ADMIN.koder.grund_mangler };
    if (begrundelse.length > 2000) return { fejl: KONKURRENCE_ADMIN.koder.begrundelse_for_lang };
    const { data, error } = await admin.rpc("konkurrence_traek_igen", {
      p_chef: userId,
      p_traekning: traekning,
      p_grund: grund,
      p_begrundelse: begrundelse || null,
    });
    if (error) throw new Error(`konkurrence_traek_igen: ${error.code ?? "ukendt"} ${error.message}`);
    await beskedTilNyVinder(admin, userId, data as TraekSvar);
    revalidatePath("/admin/konkurrence");
    return svarFraKode((data as TraekSvar)?.kode);
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: KONKURRENCE_ADMIN.koder.ingen_adgang };
    }
    await logDriftFejl({ kilde: "server", sti: "/admin/konkurrence", hvor: "Konkurrence: ny vinder", fejl: err });
    return { fejl: KONKURRENCE_ADMIN.generisk };
  }
}

// "Send besked til vinderen" - hvis den automatiske besked fejlede (fx
// samtalen kunne ikke åbnes). Kun den gældende trækning; samme idempotens som
// ved trækningen, så vinderen aldrig får samme besked to gange.
export async function sendVinderBesked(formData: FormData): Promise<Svar> {
  try {
    const { userId, admin } = await assertRole("chef");
    const traekning = String(formData.get("traekning") ?? "");
    if (!UUID.test(traekning)) return { fejl: KONKURRENCE_ADMIN.koder.findes_ikke };
    const r = await giVinderBesked(admin, userId, traekning);
    revalidatePath("/admin/konkurrence");
    if (r.status === "sendt") return { ok: true };
    return { fejl: KONKURRENCE_ADMIN.vinderBesked[r.status] ?? KONKURRENCE_ADMIN.generisk };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: KONKURRENCE_ADMIN.koder.ingen_adgang };
    }
    await logDriftFejl({ kilde: "server", sti: "/admin/konkurrence", hvor: "Konkurrence: send besked til vinderen", fejl: err });
    return { fejl: KONKURRENCE_ADMIN.generisk };
  }
}
