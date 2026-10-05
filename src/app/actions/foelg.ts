"use server";

// Følg sælgere. Al logik og alle tjek (ikke sig selv, ikke ved blokering,
// loft) ligger i databasen: foelg_saelger / stop_foelg_saelger udleder
// brugeren af auth.uid() (migration 20261007010000). Fejl RETURNERES.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = "Det lykkedes ikke. Prøv igen om lidt.";

type Svar = { ok: true } | { fejl: string };

const FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind for at følge sælgere.",
  ikke_fundet: "Sælgeren findes ikke.",
  sig_selv: "Du kan ikke følge dig selv.",
  blokeret: "Du kan ikke følge denne sælger.",
  for_mange: "Du følger allerede rigtig mange sælgere. Stop med at følge nogle, før du følger flere.",
};

async function kald(fn: "foelg_saelger" | "stop_foelg_saelger", saelgerId: string): Promise<Svar> {
  if (!UUID.test(saelgerId)) return { fejl: FEJL.ikke_fundet };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { fejl: FEJL.ikke_logget_ind };
  const { data, error } = await supabase.rpc(fn, { p_saelger: saelgerId });
  if (error) {
    console.error(`${fn} fejlede:`, error.message);
    return { fejl: GENERISK };
  }
  const kode = (data as { kode?: string } | null)?.kode;
  if (kode !== "ok") return { fejl: FEJL[kode ?? ""] ?? GENERISK };
  revalidatePath("/konto/foelger");
  revalidatePath(`/profil/${saelgerId}`);
  return { ok: true };
}

export async function foelgSaelger(saelgerId: string): Promise<Svar> {
  return kald("foelg_saelger", saelgerId);
}

export async function stopFoelgSaelger(saelgerId: string): Promise<Svar> {
  return kald("stop_foelg_saelger", saelgerId);
}
