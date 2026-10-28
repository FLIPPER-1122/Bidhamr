import "server-only";

// Brugerens adresse til fakturaer (20261102340000_bruger_adresse.sql) - ÉN
// kodevej for hjemmesiden (server action, Min adresse, formularen før bud og
// betaling), appen (GET/POST /api/konto/adresse) og oprettelsen af kontoen
// (src/lib/kontoOprettelse.ts).
//
// - Læsning sker med brugerens EGEN session (RLS: kun egen række).
// - Gem sker med gem_min_adresse() (auth.uid() i databasen) - aldrig et
//   bruger-id fra klienten. Kun oprettelsen bruger service role
//   (bruger_adresse_gem), efter koden fra mailen er bekræftet.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { adresseKodeFejl, validerAdresse, type Adresse, type AdresseFelt } from "@/lib/adresse/regler";

type Raekke = { adresse: string; postnummer: string; bynavn: string };

// Egen adresse. null = ingen gemt. "fejl" = kunne ikke læses.
export async function hentMinAdresse(supabase: SupabaseClient, brugerId: string): Promise<Adresse | null | "fejl"> {
  const { data, error } = await supabase
    .from("bruger_adresser")
    .select("adresse, postnummer, bynavn")
    .eq("bruger_id", brugerId)
    .maybeSingle<Raekke>();
  if (error) {
    // Også før migrationen (tabellen findes ikke): kalderen viser så ingen
    // formular, og databasen/serveren afgør kravet.
    if (error.code !== "42P01" && error.code !== "PGRST205") {
      console.error("hentMinAdresse fejlede:", error.code, error.message);
    }
    return "fejl";
  }
  return data ? { adresse: data.adresse, postnummer: data.postnummer, by: data.bynavn } : null;
}

// Har brugeren en adresse? Til kravet før betaling (serveren). Service role,
// fordi betalingen startes med admin-klienten. Ved en læsefejl svares true
// (fail open), så en databasefejl ikke stopper betalinger - databasen har
// stadig kravet før bud.
export async function harAdresse(brugerId: string): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient()
      .from("bruger_adresser")
      .select("bruger_id")
      .eq("bruger_id", brugerId)
      .maybeSingle<{ bruger_id: string }>();
    if (error) {
      if (error.code !== "42P01" && error.code !== "PGRST205") {
        await logDriftFejl({ kilde: "server", hvor: "harAdresse", fejl: `${error.code ?? ""}: ${error.message}`, brugerId });
      }
      return true;
    }
    return !!data;
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "harAdresse", fejl: err, brugerId });
    return true;
  }
}

export type GemAdresseSvar = { ok: true; adresse: Adresse } | { fejl: string; felt?: AdresseFelt; konto?: true };

function fraDatabasen(data: unknown): GemAdresseSvar {
  const d = (data ?? {}) as { kode?: unknown; adresse?: unknown; postnummer?: unknown; by?: unknown };
  if (d.kode === "ok" && typeof d.adresse === "string" && typeof d.postnummer === "string" && typeof d.by === "string") {
    return { ok: true, adresse: { adresse: d.adresse, postnummer: d.postnummer, by: d.by } };
  }
  return adresseKodeFejl(d.kode);
}

// Gemmer brugerens egen adresse (gem_min_adresse - auth.uid()). Input er rå
// fra klienten; valideres her og igen i databasen.
export async function gemMinAdresse(
  supabase: SupabaseClient,
  brugerId: string,
  input: { adresse: unknown; postnummer: unknown },
): Promise<GemAdresseSvar> {
  const v = validerAdresse(input);
  if ("fejl" in v) return v;
  const { data, error } = await supabase.rpc("gem_min_adresse", {
    p_adresse: v.adresse.adresse,
    p_postnummer: v.adresse.postnummer,
  });
  if (error) {
    await logDriftFejl({ kilde: "action", hvor: "gemMinAdresse", fejl: `${error.code ?? ""}: ${error.message}`, brugerId });
    return adresseKodeFejl("fejl");
  }
  return fraDatabasen(data);
}

// Oprettelse af konto: adressen fra den, der har koden fra mailen, gemmes
// med service role (der er ingen brugersession endnu på serveren). Kaster
// aldrig; false = ikke gemt (brugeren bliver bedt om den før første bud og
// betaling).
export async function gemAdresseVedOprettelse(
  brugerId: string,
  input: { adresse: unknown; postnummer: unknown } | null | undefined,
): Promise<boolean> {
  if (!input) return false;
  const v = validerAdresse(input);
  if ("fejl" in v) return false;
  try {
    const { data, error } = await createAdminClient().rpc("bruger_adresse_gem", {
      p_bruger: brugerId,
      p_adresse: v.adresse.adresse,
      p_postnummer: v.adresse.postnummer,
    });
    if (error) {
      await logDriftFejl({ kilde: "action", hvor: "bekraeftKode.adresse", fejl: `${error.code ?? ""}: ${error.message}`, brugerId });
      return false;
    }
    return "ok" in fraDatabasen(data);
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: "bekraeftKode.adresse", fejl: err, brugerId });
    return false;
  }
}

// Navnet på fakturaer: navnet fra MitID, når brugeren er verificeret
// (låst), ellers profilens navn. Egen session (RLS på
// mitid_verificeringer: kun brugeren selv).
export async function hentFakturaNavn(
  supabase: SupabaseClient,
  brugerId: string,
): Promise<{ navn: string | null; mitid: boolean }> {
  const [{ data: m }, n] = await Promise.all([
    supabase
      .from("mitid_verificeringer")
      .select("juridisk_navn")
      .eq("bruger_id", brugerId)
      .eq("status", "aktiv")
      .maybeSingle<{ juridisk_navn: string | null }>(),
    // Eget fulde navn: mit_navn() (20261102060000). Før den migration kan
    // users.navn læses direkte.
    supabase.rpc("mit_navn").maybeSingle<{ navn: string | null }>(),
  ]);
  const mitidNavn = m?.juridisk_navn?.trim() || null;
  if (mitidNavn) return { navn: mitidNavn, mitid: true };
  let navn = n.data?.navn?.trim() || null;
  if (n.error) {
    const { data } = await supabase.from("users").select("navn").eq("id", brugerId).maybeSingle<{ navn: string | null }>();
    navn = data?.navn?.trim() || null;
  }
  return { navn, mitid: false };
}
