"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { logDriftFejl } from "@/lib/drift";
import { erMaaned, GRUNDE_NY_VINDER, type GrundNyVinder } from "@/lib/konkurrence/regler";
import { KONKURRENCE_ADMIN } from "@/lib/tekster/konkurrence";

// Admin → Konkurrence (KUN chef): træk månedens vinder og træk en ny vinder.
// Rollen tjekkes her OG i databasen (konkurrence_er_chef). Seedet laves af
// databasen i samme transaktion som trækningen (32 kryptografisk tilfældige
// bytes) og gemmes sammen med den fastfrosne liste, så trækningen kan
// efterregnes (20261023020000_badge_konkurrence.sql). Hverken chefen eller
// serveren kan vælge det. Databasen sørger for, at et dobbeltklik ikke giver
// to trækninger.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Svar = { ok: true } | { fejl: string };

function svarFraKode(kode: string | undefined): Svar {
  if (kode === "ok") return { ok: true };
  return { fejl: (kode && KONKURRENCE_ADMIN.koder[kode]) || KONKURRENCE_ADMIN.generisk };
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
    revalidatePath("/admin/konkurrence");
    return svarFraKode((data as { kode?: string } | null)?.kode);
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
    revalidatePath("/admin/konkurrence");
    return svarFraKode((data as { kode?: string } | null)?.kode);
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && (err.message === "Ingen adgang" || err.message === "Ikke logget ind")) {
      return { fejl: KONKURRENCE_ADMIN.koder.ingen_adgang };
    }
    await logDriftFejl({ kilde: "server", sti: "/admin/konkurrence", hvor: "Konkurrence: ny vinder", fejl: err });
    return { fejl: KONKURRENCE_ADMIN.generisk };
  }
}
