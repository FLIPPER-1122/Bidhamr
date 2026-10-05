"use server";

// Bedømmelser (ROADMAP.md fase 4): sælgerens ét offentlige svar og
// rapporter af bedømmelser/svar. Alle kald går til databasefunktioner, der
// udleder brugeren af auth.uid() (skriv_bedoemmelse_svar,
// slet_bedoemmelse_svar, rapporter_bedoemmelse). Fejl RETURNERES.

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { KONTAKTINFO_FEJL } from "@/lib/kontaktInfo";
import { RAPPORT_BESKRIVELSE_MAKS } from "@/lib/tryghed";
import {
  MAKS_SVAR_TEGN,
  SVAR_RET_TIMER,
  erBedoemmelseRapportKategori,
  type BedoemmelseDel,
} from "@/lib/bedoemmelser";
import { notificerBedoemmelseSvar } from "@/lib/notifikationer/bedoemmelse";

type Svar = { ok: true } | { fejl: string };
const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind.",
  konto_lukket: "Din konto er lukket.",
  suspenderet: "Din konto er suspenderet, og du kan ikke svare på bedømmelser.",
  ikke_fundet: "Bedømmelsen findes ikke, eller du kan ikke svare på den.",
  skjult: "Bedømmelsen eller svaret er skjult af BidHamr og kan ikke ændres.",
  slettet: "Du har slettet dit svar, og der kan kun skrives ét svar pr. bedømmelse.",
  laast: `Svaret kan kun rettes eller slettes de første ${SVAR_RET_TIMER} timer.`,
  ugyldig_tekst: `Svaret skal være mellem 1 og ${MAKS_SVAR_TEGN} tegn.`,
  kontaktinfo: KONTAKTINFO_FEJL,
  groft_sprog:
    "Svaret indeholder ord, der ikke er tilladt på BidHamr. Hold en saglig tone – også selvom du er uenig.",
};

const RAPPORT_FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind for at rapportere.",
  ugyldig_kategori: "Vælg, hvad det drejer sig om.",
  beskrivelse_mangler: "Beskriv kort, hvad der er galt.",
  for_lang_tekst: `Beskrivelsen må højst være ${RAPPORT_BESKRIVELSE_MAKS} tegn.`,
  ikke_fundet: "Det, du vil rapportere, findes ikke længere.",
  sig_selv: "Du kan ikke rapportere det, du selv har skrevet.",
  findes: "Du har allerede rapporteret dette. Vi kigger på det.",
  for_mange: "Du har sendt mange rapporter i dag. Prøv igen i morgen, eller skriv til os via kontaktformularen.",
};

async function kald(
  fn: string,
  args: Record<string, unknown>,
): Promise<{ kode: string; id?: string; ny?: boolean; brugerId?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kode: "ikke_logget_ind" };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    console.error(`${fn} fejlede:`, error.code, error.message);
    return { kode: "fejl" };
  }
  const d = (data ?? {}) as { kode?: string; id?: string; ny?: boolean };
  return { kode: d.kode ?? "fejl", id: d.id, ny: d.ny, brugerId: user.id };
}

// Sælgeren skriver eller retter sit svar på en bedømmelse.
export async function skrivBedoemmelseSvar(ratingId: string, tekst: string): Promise<Svar> {
  try {
    if (!UUID.test(ratingId)) return { fejl: FEJL.ikke_fundet };
    const t = typeof tekst === "string" ? tekst.trim() : "";
    if (t.length < 1 || t.length > MAKS_SVAR_TEGN) return { fejl: FEJL.ugyldig_tekst };
    // Kontaktinfo og grove ord afgøres af databasen.

    const r = await kald("skriv_bedoemmelse_svar", { p_rating: ratingId, p_tekst: t });
    if (r.kode !== "ok") return { fejl: FEJL[r.kode] ?? GENERISK };

    const svarId = r.id;
    if (r.ny && svarId) after(() => notificerBedoemmelseSvar(svarId));
    if (r.brugerId) revalidatePath(`/profil/${r.brugerId}`);
    return { ok: true };
  } catch (err) {
    console.error("skrivBedoemmelseSvar fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Sælgeren sletter sit svar (inden for 48 timer). Det kan ikke skrives igen.
export async function sletBedoemmelseSvar(ratingId: string): Promise<Svar> {
  try {
    if (!UUID.test(ratingId)) return { fejl: FEJL.ikke_fundet };
    const r = await kald("slet_bedoemmelse_svar", { p_rating: ratingId });
    if (r.kode !== "ok") return { fejl: FEJL[r.kode] ?? GENERISK };
    if (r.brugerId) revalidatePath(`/profil/${r.brugerId}`);
    return { ok: true };
  } catch (err) {
    console.error("sletBedoemmelseSvar fejlede:", err);
    return { fejl: GENERISK };
  }
}

// Rapportér en bedømmelse eller sælgerens svar. Lander i admin under
// Bedømmelser.
export async function rapporterBedoemmelse(input: {
  ratingId: string;
  del: BedoemmelseDel;
  kategori: string;
  beskrivelse?: string | null;
}): Promise<Svar> {
  try {
    if (!UUID.test(input.ratingId)) return { fejl: RAPPORT_FEJL.ikke_fundet };
    if (input.del !== "bedoemmelse" && input.del !== "svar") return { fejl: RAPPORT_FEJL.ikke_fundet };
    if (!erBedoemmelseRapportKategori(input.kategori)) return { fejl: RAPPORT_FEJL.ugyldig_kategori };
    const beskrivelse = (input.beskrivelse ?? "").trim();
    if (beskrivelse.length > RAPPORT_BESKRIVELSE_MAKS) return { fejl: RAPPORT_FEJL.for_lang_tekst };

    const r = await kald("rapporter_bedoemmelse", {
      p_rating: input.ratingId,
      p_del: input.del,
      p_kategori: input.kategori,
      p_beskrivelse: beskrivelse || null,
    });
    if (r.kode === "ok") return { ok: true };
    return { fejl: RAPPORT_FEJL[r.kode] ?? GENERISK };
  } catch (err) {
    console.error("rapporterBedoemmelse fejlede:", err);
    return { fejl: GENERISK };
  }
}
