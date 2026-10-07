"use server";

// Server actions til klokken, indbakken og indstillingssiden. Alt sker med
// brugerens egen session: RLS giver kun adgang til egne rækker, og skrivning
// går gennem security definer-funktioner, der udleder brugeren af auth.uid().
// Fejl RETURNERES som { fejl } (Next skjuler kastede fejl i produktion).
//
// Appen (Expo) kalder de samme ting direkte med supabase-js og brugerens session:
//   supabase.rpc("push_token_registrer", { p_token, p_platform: "ios" | "android" | "web" })
//       efter login og ved hver opstart (token fra getExpoPushTokenAsync).
//   supabase.rpc("push_token_fjern", { p_token })          ved log ud.
//   (Appen kan også skrive direkte i push_tokens via RLS; RPC'en håndhæver
//   desuden højst 10 enheder pr. bruger. Kun Expo-tokens får push.
//   Sidste registrering vinder: logger en anden bruger ind på enheden,
//   overtager han tokenet, så push går til den, der er logget ind nu.)
//   supabase.from("notifikationer").select(...)             indbakken (RLS: kun egne).
//   supabase.rpc("notifikationer_antal_ulaeste")            rødt tal.
//   supabase.rpc("notifikationer_marker_laest", { p_ids }) / ("notifikationer_marker_alle_laest")
//   supabase.from("notifikation_indstillinger").select(...) + rpc("notifikation_gem_indstillinger",
//       { p_indstillinger: [{ type, klokke, mail, push }] })  -> { kode: "ok" | ... }
// Push-beskeder har data = { type, link, ...}; appen åbner `link` ved tryk.
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import {
  ALLE_TYPER,
  type Kanaler,
  type NotifikationType,
  NOTIFIKATION_TYPER,
  STANDARD_KANALER,
  erKendtType,
  erPaakraevet,
} from "@/lib/notifikationer/typer";

export type Notifikation = {
  id: string;
  type: NotifikationType;
  titel: string;
  tekst: string;
  link: string | null;
  data: Record<string, unknown>;
  laest_kl: string | null;
  oprettet_kl: string;
};

export type Indstilling = Kanaler & {
  type: NotifikationType;
  navn: string;
  beskrivelse: string;
  paakraevet: boolean;
};

const IKKE_LOGGET_IND = "Du skal være logget ind.";
const GENERISK = "Noget gik galt. Prøv igen om lidt.";

async function bruger() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  return { supabase, user };
}

// Nyeste først. `foer` = oprettet_kl på den sidste viste (til "vis flere").
export async function hentNotifikationer(
  opts: { antal?: number; foer?: string | null; kunUlaeste?: boolean } = {},
): Promise<{ notifikationer: Notifikation[] } | { fejl: string }> {
  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  const antal = Math.min(Math.max(Math.trunc(opts.antal ?? 20), 1), 100);

  let q = supabase
    .from("notifikationer")
    .select("id, type, titel, tekst, link, data, laest_kl, oprettet_kl")
    .eq("bruger_id", user.id)
    .order("oprettet_kl", { ascending: false })
    .limit(antal);
  if (opts.foer && !Number.isNaN(Date.parse(opts.foer))) q = q.lt("oprettet_kl", opts.foer);
  if (opts.kunUlaeste) q = q.is("laest_kl", null);

  const { data, error } = await q.overrideTypes<Notifikation[], { merge: false }>();
  if (error) {
    console.error("hentNotifikationer fejlede:", error.message);
    return { fejl: GENERISK };
  }
  return { notifikationer: data ?? [] };
}

// Til det røde tal på klokken. Ikke logget ind = 0.
export async function antalUlaeste(): Promise<{ antal: number } | { fejl: string }> {
  const { supabase, user } = await bruger();
  if (!user) return { antal: 0 };
  const { data, error } = await supabase.rpc("notifikationer_antal_ulaeste");
  if (error) {
    console.error("antalUlaeste fejlede:", error.message);
    return { fejl: GENERISK };
  }
  return { antal: Number(data ?? 0) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function markerLaest(
  ids: string[],
): Promise<{ ok: true; antal: number } | { fejl: string }> {
  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  if (!Array.isArray(ids)) return { fejl: "Ugyldig forespørgsel." };
  const rene = [...new Set(ids.filter((id) => typeof id === "string" && UUID.test(id)))];
  if (rene.length === 0) return { ok: true, antal: 0 };
  if (rene.length > 500) return { fejl: "For mange notifikationer på én gang." };
  const { data, error } = await supabase.rpc("notifikationer_marker_laest", { p_ids: rene });
  if (error) {
    console.error("markerLaest fejlede:", error.message);
    return { fejl: GENERISK };
  }
  return { ok: true, antal: Number(data ?? 0) };
}

export async function markerAlleLaest(): Promise<{ ok: true; antal: number } | { fejl: string }> {
  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  const { data, error } = await supabase.rpc("notifikationer_marker_alle_laest");
  if (error) {
    console.error("markerAlleLaest fejlede:", error.message);
    return { fejl: GENERISK };
  }
  return { ok: true, antal: Number(data ?? 0) };
}

// Alle typer i fast rækkefølge, med standard (alt til) hvor intet er gemt.
export async function hentIndstillinger(): Promise<
  { indstillinger: Indstilling[] } | { fejl: string }
> {
  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  const { data, error } = await supabase
    .from("notifikation_indstillinger")
    .select("type, klokke, mail, push")
    .eq("bruger_id", user.id);
  if (error) {
    console.error("hentIndstillinger fejlede:", error.message);
    return { fejl: GENERISK };
  }
  const gemt = new Map((data ?? []).map((r) => [r.type as string, r as Kanaler]));
  return {
    indstillinger: NOTIFIKATION_TYPER.map((t) => {
      const k = gemt.get(t.type) ?? STANDARD_KANALER;
      return { ...t, klokke: k.klokke, mail: k.mail, push: k.push };
    }),
  };
}

// Gemmer én eller flere typer atomisk. Påkrævede typer skal have mindst én kanal.
export async function gemIndstillinger(
  indstillinger: ({ type: string } & Kanaler)[],
): Promise<{ ok: true } | { fejl: string }> {
  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  if (!Array.isArray(indstillinger) || indstillinger.length === 0) {
    return { fejl: "Der er intet at gemme." };
  }
  if (indstillinger.length > ALLE_TYPER.length) return { fejl: "Ugyldig forespørgsel." };

  const rene: ({ type: NotifikationType } & Kanaler)[] = [];
  for (const i of indstillinger) {
    if (!i || !erKendtType(i.type)) return { fejl: "Ukendt notifikationstype." };
    const k = { klokke: i.klokke === true, mail: i.mail === true, push: i.push === true };
    if (erPaakraevet(i.type) && !k.klokke && !k.mail && !k.push) {
      const navn = NOTIFIKATION_TYPER.find((t) => t.type === i.type)?.navn ?? i.type;
      return { fejl: `"${navn}" kan ikke slås helt fra. Vælg mindst én måde at få beskeden på.` };
    }
    rene.push({ type: i.type, ...k });
  }

  const { data, error } = await supabase.rpc("notifikation_gem_indstillinger", {
    p_indstillinger: rene,
  });
  if (error) {
    console.error("gemIndstillinger fejlede:", error.message);
    return { fejl: GENERISK };
  }
  const kode = (data as { kode?: string } | null)?.kode;
  if (kode === "ok") return { ok: true };
  if (kode === "mindst_en_kanal") {
    return { fejl: "En påkrævet besked kan ikke slås helt fra. Vælg mindst én måde at få den på." };
  }
  if (kode === "ikke_logget_ind") return { fejl: IKKE_LOGGET_IND };
  return { fejl: "Indstillingerne kunne ikke gemmes." };
}

// Til appen, hvis den går via en server action. Normalt kalder appen RPC'en
// push_token_registrer direkte (se øverst i filen).
export async function registrerPushToken(
  token: string,
  platform: "ios" | "android" | "web",
): Promise<{ ok: true } | { fejl: string }> {
  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  const { data, error } = await supabase.rpc("push_token_registrer", {
    p_token: typeof token === "string" ? token.trim() : "",
    p_platform: platform,
  });
  if (error) {
    console.error("registrerPushToken fejlede:", error.message);
    return { fejl: GENERISK };
  }
  const kode = (data as { kode?: string } | null)?.kode;
  if (kode === "ok") return { ok: true };
  if (kode === "ugyldigt_token") return { fejl: "Ugyldigt push-token." };
  if (kode === "ugyldig_platform") return { fejl: "Ukendt platform." };
  return { fejl: GENERISK };
}

export async function fjernPushToken(token: string): Promise<{ ok: true } | { fejl: string }> {
  const { supabase, user } = await bruger();
  if (!user) return { fejl: IKKE_LOGGET_IND };
  const { error } = await supabase.rpc("push_token_fjern", {
    p_token: typeof token === "string" ? token.trim() : "",
  });
  if (error) {
    console.error("fjernPushToken fejlede:", error.message);
    return { fejl: GENERISK };
  }
  return { ok: true };
}
