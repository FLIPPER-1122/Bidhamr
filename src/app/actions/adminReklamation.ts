"use server";

// Staff: reklamation hos fragtfirma (migration 20261029010000). Sælgeren
// anmelder selv; staff ser alt, skriver noter, sender pakken/påmindelsen
// igen, annullerer, retter status og vurderer indpakningen som ordentlig.
// Én action pr. knap.
//
// Adgang: assertRole("medarbejder") (rolle + to-trins-login på admin-hosten),
// og databasen tjekker igen med BRUGERENS session: auth.uid() + er_staff()
// (rolle OG aal2) + inhabilitet. Derfor kaldes RPC'erne med createClient()
// - ikke service-role. NB: uden ADMIN_VAERT (ingen aal2-session) svarer
// databasen ingen_adgang.
// Fejl RETURNERES som { fejl } (Next skjuler kastede fejl i produktion).
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { assertRole } from "@/lib/adminAuth";
import { createClient } from "@/lib/supabase/server";
import { adminSagSti, sagSti } from "@/lib/sager";
import { notificerReklamationer } from "@/lib/reklamation/notifikationer";
import { erRetStatus, fortolkKroner, kroner } from "@/lib/reklamation/typer";

export type ReklamationSvar = { ok: true; uaendret?: boolean } | { fejl: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const INGEN_ADGANG = "Du har ikke adgang til at gøre dette.";

const KODE: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang. Log ind i admin med to-trins-login, og prøv igen.",
  ikke_fundet: "Reklamationen findes ikke. Genindlæs siden.",
  inhabil: "Du er inhabil: du er part i handlen eller har handlet med en af parterne. Lad en kollega tage den.",
  forkert_status: "Reklamationen har ændret status. Genindlæs siden.",
  for_lang_tekst: "Teksten er for lang. Gør den kortere.",
  grund_mangler: "Skriv en begrundelse. Den vises for sælgeren.",
  begrundelse_mangler: "Skriv en intern begrundelse for rettelsen.",
  ugyldig_status: "Vælg en status.",
  ugyldigt_beloeb: "Beløbet er ugyldigt.",
  for_hurtigt: "Beskeden er lige sendt. Vent et minut, og prøv igen.",
  ikke_skadet: "Indpakningen vurderes kun i sager om skade under fragten.",
  afhentning: "Varen blev afhentet – der er ingen indpakning at vurdere.",
  allerede_vurderet: "Indpakningen er allerede vurderet i denne sag.",
  ikke_vurderet: "Indpakningen er ikke vurderet som ordentlig.",
  reklamation_anmeldt: "Sælgeren har allerede anmeldt skaden. Ret reklamationens status i stedet.",
  uaendret: "Intet at ændre.",
  ikke_aendret: "Der er ingen ændret sag at kvittere for. Genindlæs siden.",
};

// Hvorfor reklamationen ikke kan være åben/anmeldt/godkendt
// (fragt_reklamation_betingelser).
const BETINGELSE: Record<string, string> = {
  ikke_refunderet: "køberen har ikke fået pengene tilbage (refusionen er ikke bekræftet)",
  ikke_koebers_fordel: "sagen er ikke endeligt afgjort til køberens fordel",
  anke_venter: "en anke venter på afgørelse",
  ankefrist: "ankefristen er ikke udløbet endnu",
  indpakning: "indpakningen er ikke vurderet som ordentlig",
  ingen_forsendelse: "der er ingen pakke med DAO eller GLS på handlen",
  afhentning: "varen blev afhentet",
  ikke_skadet: "sagen handler ikke om skade under fragten",
  ingen_handel: "handlen findes ikke",
  ingen_vaerdi: "varens værdi kan ikke findes",
};

function erUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

function fejlTekst(svar: Record<string, unknown>): string {
  const kode = String(svar.kode ?? "");
  if (kode === "ugyldigt_beloeb" && typeof svar.maks_oere === "number") {
    return `Beløbet skal være mellem 0,01 kr. og ${kroner(svar.maks_oere)}.`;
  }
  if (kode === "allerede_vurderet" && svar.resultat === "ordentlig") {
    return "Indpakningen er allerede vurderet som ordentlig.";
  }
  if (kode === "allerede_vurderet") {
    return "Indpakningen er allerede vurderet som dårlig i denne sag.";
  }
  if (kode === "betingelser_ikke_opfyldt") {
    const grund = BETINGELSE[String(svar.aarsag ?? "")];
    return `Reklamationen kan ikke åbnes igen, fordi ${grund ?? "betingelserne ikke er opfyldt"}. Vælg afvist, fravalgt eller annullér.`;
  }
  return KODE[kode] ?? GENERISK;
}

async function koer(
  navn: string,
  rpc: string,
  args: Record<string, unknown>,
  stier: { sagId?: string; tradeId?: string } = {},
): Promise<ReklamationSvar> {
  try {
    await assertRole("medarbejder");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(rpc, args);
    if (error) {
      if (["PGRST202", "42883"].includes(error.code ?? "")) {
        return { fejl: "Reklamationer kræver migrationen 20261029010000_reklamation_fragtfirma.sql." };
      }
      throw new Error(error.message);
    }
    const svar = (data ?? {}) as Record<string, unknown>;
    if (svar.kode !== "ok") return { fejl: fejlTekst(svar) };
    // Besked til sælgeren (oprettet, gensendt, annulleret) med det samme -
    // cron'en tager den ellers inden for 5 minutter.
    after(() => notificerReklamationer());
    revalidatePath("/admin/sager");
    if (stier.sagId) revalidatePath(adminSagSti(stier.sagId));
    if (stier.tradeId) revalidatePath(sagSti(stier.tradeId));
    return svar.uaendret === true ? { ok: true, uaendret: true } : { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof Error && ["Ingen adgang", "Ikke logget ind", "Kræver to-trins-login"].includes(err.message)) {
      return { fejl: INGEN_ADGANG };
    }
    console.error(`Reklamation: ${navn} fejlede:`, err);
    return { fejl: GENERISK };
  }
}

// --- Indpakning (på sagen) ---------------------------------------------------

// "Indpakningen er ordentlig". Reklamationen oprettes automatisk, når sagen
// er endelig til købers fordel, og køberen er refunderet (med det samme,
// hvis det allerede er sket - ellers af triggeren/cron'en).
export async function vurderIndpakningOrdentlig(sagId: string, internNote?: string): Promise<ReklamationSvar> {
  if (!erUuid(sagId)) return { fejl: "Sagen findes ikke." };
  return koer("vurderIndpakningOrdentlig", "indpakning_ordentlig", {
    p_sag: sagId,
    p_intern_note: typeof internNote === "string" ? internNote : null,
  }, { sagId });
}

export async function fortrydIndpakningOrdentlig(sagId: string, grund: string): Promise<ReklamationSvar> {
  if (!erUuid(sagId)) return { fejl: "Sagen findes ikke." };
  return koer("fortrydIndpakningOrdentlig", "indpakning_ordentlig_fortryd", {
    p_sag: sagId,
    p_grund: typeof grund === "string" ? grund : "",
  }, { sagId });
}

// --- Reklamationen -----------------------------------------------------------

export async function gemReklamationNote(reklamationId: string, note: string, sagId?: string): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  return koer("gemReklamationNote", "fragt_reklamation_gem_note", {
    p_reklamation: reklamationId,
    p_note: typeof note === "string" ? note : "",
  }, { sagId: erUuid(sagId) ? sagId : undefined });
}

// Send pakken/påmindelsen til sælgeren igen (notifikation + mail).
export async function sendReklamationIgen(reklamationId: string, sagId?: string): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  return koer("sendReklamationIgen", "fragt_reklamation_send_igen", { p_reklamation: reklamationId }, {
    sagId: erUuid(sagId) ? sagId : undefined,
  });
}

export async function annullerReklamation(reklamationId: string, grund: string, sagId?: string): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  return koer("annullerReklamation", "fragt_reklamation_annuller", {
    p_reklamation: reklamationId,
    p_grund: typeof grund === "string" ? grund : "",
  }, { sagId: erUuid(sagId) ? sagId : undefined });
}

// Sagen er ændret efter sælgerens anmeldelse: staff kvitterer ("set -
// reklamationen fortsætter"). Sælgeren kan så igen registrere "godkendt" og
// får besked. begrundelse er intern og påkrævet.
export async function kvitterSagAendret(reklamationId: string, begrundelse: string, sagId?: string): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  return koer("kvitterSagAendret", "fragt_reklamation_kvitter_sag_aendret", {
    p_reklamation: reklamationId,
    p_begrundelse: typeof begrundelse === "string" ? begrundelse : "",
  }, { sagId: erUuid(sagId) ? sagId : undefined });
}

// Ret status, hvis sælgeren har registreret forkert. beloebKr kræves ved
// "godkendt" (dansk format, fx "1.250,00"). begrundelse er intern og påkrævet.
export async function retReklamationStatus(input: {
  reklamationId: string;
  status: string;
  beloebKr?: string;
  sagsnummer?: string;
  grund?: string;
  begrundelse: string;
  sagId?: string;
}): Promise<ReklamationSvar> {
  if (!erUuid(input?.reklamationId)) return { fejl: KODE.ikke_fundet };
  if (!erRetStatus(input.status)) return { fejl: KODE.ugyldig_status };
  let beloeb: number | null = null;
  if (input.status === "godkendt") {
    const b = fortolkKroner(String(input.beloebKr ?? ""));
    if ("fejl" in b) return { fejl: b.fejl };
    beloeb = b.oere;
  }
  return koer("retReklamationStatus", "fragt_reklamation_ret_status", {
    p_reklamation: input.reklamationId,
    p_status: input.status,
    p_beloeb_oere: beloeb,
    p_sagsnummer: typeof input.sagsnummer === "string" ? input.sagsnummer : null,
    p_grund: typeof input.grund === "string" ? input.grund : null,
    p_begrundelse: typeof input.begrundelse === "string" ? input.begrundelse : "",
  }, { sagId: erUuid(input.sagId) ? input.sagId : undefined });
}
