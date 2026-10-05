"use server";

// Gemte søgninger. Skriver direkte i gemte_soegninger med brugerens egen
// session - RLS sikrer, at man kun kan se og ændre sine egne, kolonne-grants
// at kun navn og besked kan ændres, og en trigger håndhæver højst 20 pr.
// bruger (migration 20261007010000). Fejl RETURNERES.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { kategorier } from "@/lib/kategorier";
import { slaaPostnummerOp } from "@/lib/postnumre";
import {
  MAKS_GEMTE_SOEGNINGER,
  MAKS_NAVN,
  MAKS_SOEGEORD,
  type GemtSoegning,
  type SoegeKriterier,
} from "@/lib/gemteSoegninger";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = "Det lykkedes ikke. Prøv igen om lidt.";
const IKKE_LOGGET_IND = "Du skal være logget ind for at gemme søgninger.";

type Svar = { ok: true } | { fejl: string };

const ren = (s: unknown, maks: number) =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, maks) : "";

async function bruger() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function hentGemteSoegninger(): Promise<{ soegninger: GemtSoegning[] } | { fejl: string }> {
  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  const { data, error } = await supabase
    .from("gemte_soegninger")
    .select("id, navn, soegeord, kategori, postnummer, radius_km, besked, oprettet_kl")
    .order("oprettet_kl", { ascending: false })
    .limit(MAKS_GEMTE_SOEGNINGER);
  if (error) {
    console.error("Gemte søgninger kunne ikke hentes:", error.message);
    return { fejl: "Dine gemte søgninger kunne ikke hentes. Prøv igen om lidt." };
  }
  return {
    soegninger: (data ?? []).map((r) => ({
      id: r.id as string,
      navn: r.navn as string,
      soegeord: (r.soegeord as string) ?? "",
      kategori: (r.kategori as string | null) ?? null,
      postnummer: (r.postnummer as string | null) ?? null,
      radiusKm: (r.radius_km as number | null) ?? null,
      besked: r.besked as boolean,
      oprettetKl: r.oprettet_kl as string,
    })),
  };
}

export async function gemSoegning(navn: string, k: SoegeKriterier): Promise<Svar> {
  const soegeord = ren(k?.soegeord, MAKS_SOEGEORD);
  const kategori = kategorier.find((x) => x === k?.kategori) ?? null;
  if (!soegeord && !kategori) {
    return { fejl: "Skriv et søgeord eller vælg en kategori, før du gemmer søgningen." };
  }
  const rentNavn = ren(navn, MAKS_NAVN) || (soegeord || kategori || "").slice(0, MAKS_NAVN);

  // Afstand kræver et kendt postnummer. Koordinaten slås op her (samme liste
  // som filteret på /auktioner) - aldrig fra browseren.
  const opslag = slaaPostnummerOp(k?.postnummer ?? null);
  const radius =
    opslag && typeof k?.radiusKm === "number" && Number.isInteger(k.radiusKm) && k.radiusKm >= 5 && k.radiusKm < 150
      ? k.radiusKm
      : null;

  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  const { error } = await supabase.from("gemte_soegninger").insert({
    navn: rentNavn,
    soegeord,
    kategori,
    postnummer: radius ? opslag!.postnummer : null,
    radius_km: radius,
    lat: radius ? opslag!.lat : null,
    lng: radius ? opslag!.lng : null,
    besked: true,
  });
  if (error) {
    if (error.code === "23505") return { fejl: "Du har allerede gemt præcis denne søgning." };
    if (error.message.includes("for_mange")) {
      return {
        fejl: `Du kan højst gemme ${MAKS_GEMTE_SOEGNINGER} søgninger. Slet en under Min konto, og prøv igen.`,
      };
    }
    console.error("Søgning kunne ikke gemmes:", error.message);
    return { fejl: GENERISK };
  }
  revalidatePath("/konto/soegninger");
  return { ok: true };
}

export async function omdoebSoegning(id: string, navn: string): Promise<Svar> {
  if (!UUID.test(id)) return { fejl: "Søgningen findes ikke." };
  const rentNavn = ren(navn, MAKS_NAVN);
  if (!rentNavn) return { fejl: "Giv søgningen et navn." };
  return opdater(id, { navn: rentNavn });
}

export async function saetBesked(id: string, besked: boolean): Promise<Svar> {
  if (!UUID.test(id)) return { fejl: "Søgningen findes ikke." };
  return opdater(id, { besked: besked === true });
}

async function opdater(id: string, felter: { navn?: string; besked?: boolean }): Promise<Svar> {
  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  const { data, error } = await supabase
    .from("gemte_soegninger")
    .update(felter)
    .eq("id", id)
    .select("id");
  if (error) {
    console.error("Søgning kunne ikke opdateres:", error.message);
    return { fejl: GENERISK };
  }
  if (!data || data.length === 0) return { fejl: "Søgningen findes ikke." };
  revalidatePath("/konto/soegninger");
  return { ok: true };
}

export async function sletSoegning(id: string): Promise<Svar> {
  if (!UUID.test(id)) return { fejl: "Søgningen findes ikke." };
  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  const { error } = await supabase.from("gemte_soegninger").delete().eq("id", id);
  if (error) {
    console.error("Søgning kunne ikke slettes:", error.message);
    return { fejl: GENERISK };
  }
  revalidatePath("/konto/soegninger");
  return { ok: true };
}
