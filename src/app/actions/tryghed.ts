"use server";

// Blokering og rapporter af beskeder/brugere. Al logik og alle tjek ligger i
// databasen (bloker_bruger, bloker_byder, fjern_blokering,
// fjern_blokering_af_bruger, rapporter_bruger - alle udleder kalderen af
// auth.uid()). Her oversættes koderne til danske beskeder. Fejl RETURNERES.

import { revalidatePath } from "next/cache";
import { getUserMedToTrin } from "@/lib/mfa";
import { createClient } from "@/lib/supabase/server";
import { erRapportKategori, RAPPORT_BESKRIVELSE_MAKS } from "@/lib/tryghed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = "Det lykkedes ikke. Prøv igen om lidt.";

type Svar = { ok: true } | { fejl: string };

const FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind.",
  ikke_fundet: "Brugeren findes ikke.",
  sig_selv: "Du kan ikke blokere dig selv.",
  for_mange: "Du har blokeret mange brugere i dag. Prøv igen i morgen.",
};

async function kald(fn: string, args: Record<string, unknown>): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getUserMedToTrin(supabase);
  if (!user) return "ikke_logget_ind";
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    console.error(`${fn} fejlede:`, error.message);
    return "fejl";
  }
  return ((data as { kode?: string } | null)?.kode ?? "fejl") as string;
}

export async function blokerBruger(brugerId: string): Promise<Svar> {
  if (!UUID.test(brugerId)) return { fejl: FEJL.ikke_fundet };
  const kode = await kald("bloker_bruger", { p_bruger: brugerId });
  if (kode !== "ok") return { fejl: FEJL[kode ?? ""] ?? GENERISK };
  revalidatePath("/konto");
  return { ok: true };
}

export async function fjernBlokeringAfBruger(brugerId: string): Promise<Svar> {
  if (!UUID.test(brugerId)) return { fejl: FEJL.ikke_fundet };
  const kode = await kald("fjern_blokering_af_bruger", { p_bruger: brugerId });
  if (kode !== "ok") return { fejl: FEJL[kode ?? ""] ?? GENERISK };
  revalidatePath("/konto");
  return { ok: true };
}

export async function fjernBlokering(blokeringId: string): Promise<Svar> {
  if (!UUID.test(blokeringId)) return { fejl: "Blokeringen findes ikke." };
  const kode = await kald("fjern_blokering", { p_id: blokeringId });
  // ikke_fundet: allerede fjernet (fx dobbeltklik) - det er målet.
  if (kode !== "ok" && kode !== "ikke_fundet") return { fejl: FEJL[kode ?? ""] ?? GENERISK };
  revalidatePath("/konto");
  return { ok: true };
}

// Sælgeren spærrer en anonym byder ud fra et af byderens bud på sælgerens
// auktion. Byderens identitet kommer aldrig til browseren.
export async function spaerByder(budId: string): Promise<Svar> {
  if (!UUID.test(budId)) return { fejl: "Buddet findes ikke." };
  const kode = await kald("bloker_byder", { p_bud: budId });
  if (kode === "ok") {
    revalidatePath("/konto");
    return { ok: true };
  }
  if (kode === "ikke_fundet") return { fejl: "Buddet findes ikke." };
  if (kode === "sig_selv") return { fejl: "Du kan ikke spærre dig selv." };
  return { fejl: FEJL[kode ?? ""] ?? GENERISK };
}

const RAPPORT_FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind for at rapportere.",
  ugyldig_kategori: "Vælg, hvad det drejer sig om.",
  beskrivelse_mangler: "Beskriv kort, hvad der er galt.",
  for_lang_tekst: `Beskrivelsen må højst være ${RAPPORT_BESKRIVELSE_MAKS} tegn.`,
  ikke_fundet: "Det, du vil rapportere, findes ikke længere.",
  sig_selv: "Du kan ikke rapportere dig selv.",
  findes: "Du har allerede rapporteret dette. Vi kigger på det.",
  for_mange: "Du har sendt mange rapporter i dag. Prøv igen i morgen, eller skriv til os via kontaktformularen.",
};

// Rapportér en besked (beskedId) eller en bruger (brugerId).
export async function rapporter(input: {
  brugerId?: string | null;
  beskedId?: string | null;
  kategori: string;
  beskrivelse?: string | null;
}): Promise<Svar> {
  const beskedId = input.beskedId && UUID.test(input.beskedId) ? input.beskedId : null;
  const brugerId = input.brugerId && UUID.test(input.brugerId) ? input.brugerId : null;
  if (!beskedId && !brugerId) return { fejl: RAPPORT_FEJL.ikke_fundet };
  if (!erRapportKategori(input.kategori)) return { fejl: RAPPORT_FEJL.ugyldig_kategori };
  const beskrivelse = (input.beskrivelse ?? "").trim();
  if (beskrivelse.length > RAPPORT_BESKRIVELSE_MAKS) return { fejl: RAPPORT_FEJL.for_lang_tekst };

  const kode = await kald("rapporter_bruger", {
    p_bruger: beskedId ? null : brugerId,
    p_besked: beskedId,
    p_kategori: input.kategori,
    p_beskrivelse: beskrivelse || null,
  });
  if (kode === "ok") return { ok: true };
  return { fejl: RAPPORT_FEJL[kode ?? ""] ?? GENERISK };
}
