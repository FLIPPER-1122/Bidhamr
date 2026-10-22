"use server";

// Staff: reklamation hos fragtfirma (migration 20261029010000). BidHamr
// anmelder (Filip, 22. okt. 2026): staff registrerer anmeldelsen
// (sagsnummer), fragtfirmaets svar (godkendt + beløb / afvist + grund),
// annullerer, retter status, kvitterer for en ændret sag, skriver noter og
// vurderer indpakningen som ordentlig. KUN CHEFEN udbetaler erstatningen til
// sælgeren (udbetalReklamation). Én action pr. knap.
//
// Adgang: assertRole("medarbejder") / assertRole("chef") (rolle +
// to-trins-login på admin-hosten), og databasen tjekker igen med BRUGERENS
// session: auth.uid() + er_staff() (rolle OG aal2) + inhabilitet (+ rollen
// 'chef' ved udbetaling). Derfor kaldes RPC'erne med createClient() - ikke
// service-role. NB: uden ADMIN_VAERT (ingen aal2-session) svarer databasen
// ingen_adgang.
// Fejl RETURNERES som { fejl } (Next skjuler kastede fejl i produktion).
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { assertRole } from "@/lib/adminAuth";
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";
import { adminSagSti, sagSti } from "@/lib/sager";
import { notificerReklamationer } from "@/lib/reklamation/notifikationer";
import {
  REKLAMATION_MIN_OERE,
  REKLAMATION_MIN_TEKST,
  betingelseTekst,
  erRetStatus,
  fortolkKroner,
  kroner,
} from "@/lib/reklamation/typer";
import { udbetalReklamationTilBank, udfoerReklamationTransfer, type UdbetalClaim } from "@/lib/reklamation/udbetaling";

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
  sagsnummer_mangler: "Skriv fragtfirmaets sagsnummer.",
  ugyldig_status: "Vælg en status.",
  ugyldigt_beloeb: "Beløbet er ugyldigt.",
  for_lille_beloeb: REKLAMATION_MIN_TEKST,
  ikke_skadet: "Indpakningen vurderes kun i sager om skade under fragten.",
  afhentning: "Varen blev afhentet – der er ingen indpakning at vurdere.",
  allerede_vurderet: "Indpakningen er allerede vurderet i denne sag.",
  ikke_vurderet: "Indpakningen er ikke vurderet som ordentlig.",
  reklamation_anmeldt: "Skaden er allerede anmeldt hos fragtfirmaet. Ret reklamationens status i stedet.",
  uaendret: "Intet at ændre.",
  ikke_aendret: "Der er ingen ændret sag at kvittere for. Genindlæs siden.",
  sag_aendret: "Sagen er ændret efter anmeldelsen. Kvittér for ændringen først (eller ret status/annullér).",
  udbetaling_i_gang: "Chefens udbetaling er sat i gang. Vent, til den er afsluttet, og genindlæs siden.",
  // Chefens udbetaling.
  kun_chef: "Kun chefen kan udbetale erstatningen til sælgeren.",
  bekraeftelse_mangler: "Sæt flueben ved, at erstatningen er modtaget fra fragtfirmaet.",
  allerede_udbetalt: "Erstatningen er allerede udbetalt til sælgeren. Genindlæs siden.",
  stoppet: "Udbetalinger er stoppet med nødstoppet. Ingen penge er flyttet. Genoptag udbetalinger under Penge først.",
  frosset: "Sælgerens udbetalinger er frosset. Ingen penge er flyttet. Se på sælgeren under Penge først.",
  ingen_konto: "Sælgeren har ingen aktiv Stripe-konto. Ingen penge er flyttet. Sælgeren skal sætte sin udbetalingskonto op igen.",
  konto_aendret: "Sælgerens Stripe-konto er en anden end på betalingen. Ingen penge er flyttet. Kontrollér sælgeren, før du udbetaler.",
  i_gang: "Udbetalingen er i gang lige nu (startet for under 10 minutter siden). Vent lidt, og genindlæs siden – der udbetales aldrig to gange.",
  // Send til banken igen (annulleret payout).
  ikke_annulleret: "Udbetalingen til sælgerens bank er ikke annulleret. Genindlæs siden.",
  tilbagefoert:
    "Overførslen til sælgerens Stripe-konto er tilbageført eller passer ikke med reklamationen, så intet sendes til banken. Se drift-loggen og kontrollér i Stripe.",
};

// Resultatet af "send til banken igen" (udbetalReklamationTilBank).
const BANK: Record<string, string> = {
  stoppet: "Udbetalinger er stoppet med nødstoppet. Erstatningen sendes, når udbetalinger er genoptaget.",
  frosset: "Sælgerens udbetalinger er frosset. Erstatningen sendes, når frysningen er ophævet.",
  venter_paa_bank: "Sælgeren skal rette sin bankkonto hos Stripe først. Erstatningen sendes automatisk bagefter.",
  konto_ikke_klar: "Sælgerens Stripe-konto kan ikke udbetale lige nu. Erstatningen sendes automatisk, når den kan.",
  venter_saldo: "Pengene er ikke tilgængelige på sælgerens Stripe-konto endnu. Erstatningen sendes automatisk, når de er.",
  saldo_afviger:
    "Sælgerens Stripe-konto har mindre på saldoen, end erstatningen og sælgerens handler kræver. Intet er sendt – se drift-loggen og kontrollér kontoen i Stripe.",
  tilbagefoert: KODE.tilbagefoert,
  afvist: "Stripe afviste udbetalingen til banken. Den prøves igen automatisk – se drift-loggen.",
  afvist_endeligt:
    "Stripe afviste udbetalingen til banken endeligt (fx er beløbet under Stripes mindste udbetaling). Den prøves ikke igen automatisk – kontrollér i Stripe og se drift-loggen.",
  usikker: "Vi fik ikke et sikkert svar fra Stripe. Det slås op og prøves igen automatisk – der udbetales aldrig to gange.",
  i_gang: KODE.i_gang,
};

// Resultatet af Stripe-delen (udfoerReklamationTransfer).
const TRANSFER: Record<string, string> = {
  stoppet: KODE.stoppet,
  frosset: KODE.frosset,
  konto_ikke_klar: "Sælgerens Stripe-konto kan ikke modtage penge lige nu. Ingen penge er flyttet. Prøv igen senere.",
  saelger_saldo_negativ:
    "Sælgerens Stripe-konto har en negativ saldo, så erstatningen ville gå til at dække underskuddet. Ingen penge er flyttet. Se på kontoen i Stripe først.",
  platform_saldo:
    "Der er ikke nok penge på BidHamrs Stripe-saldo lige nu. Ingen penge er flyttet. Prøv igen, når der er penge nok på saldoen.",
  afvist: "Stripe afviste udbetalingen. Ingen penge er flyttet. Se drift-loggen.",
  usikker:
    "Vi fik ikke et sikkert svar fra Stripe, så det er uvist, om pengene er sendt. Tryk \"Udbetal til sælger\" igen om lidt – der udbetales aldrig to gange.",
  proev_igen: "Udbetalingen blev ikke gennemført, og ingen penge er flyttet. Bekræft og tryk igen.",
  afviger: "Udbetalingen hos Stripe passer ikke med reklamationen. Se drift-loggen, før du gør mere.",
};

function erUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

// handling: hvilken knap - betingelser_ikke_opfyldt betyder noget forskelligt.
function fejlTekst(svar: Record<string, unknown>, handling?: "kvitter" | "anmeld" | "udbetal"): string {
  const kode = String(svar.kode ?? "");
  if (kode === "ugyldigt_beloeb" && typeof svar.maks_oere === "number") {
    return svar.maks_oere < REKLAMATION_MIN_OERE
      ? `Beløbet kan højst være ${kroner(svar.maks_oere)}. ${REKLAMATION_MIN_TEKST} Reklamationen kan derfor ikke udbetales – annullér den i stedet.`
      : `Beløbet skal være mellem ${kroner(REKLAMATION_MIN_OERE)} og ${kroner(svar.maks_oere)}`;
  }
  if (kode === "for_lille_beloeb") {
    const min = typeof svar.min_oere === "number" ? svar.min_oere : REKLAMATION_MIN_OERE;
    return `Det mindste beløb, vi kan udbetale, er ${kroner(min)}`;
  }
  if (kode === "allerede_vurderet" && svar.resultat === "ordentlig") {
    return "Indpakningen er allerede vurderet som ordentlig.";
  }
  if (kode === "allerede_vurderet") {
    return "Indpakningen er allerede vurderet som dårlig i denne sag.";
  }
  if (kode === "betingelser_ikke_opfyldt") {
    const grund = betingelseTekst(typeof svar.aarsag === "string" ? svar.aarsag : null);
    if (handling === "kvitter") {
      return `Reklamationen kan ikke fortsætte, fordi ${grund}. Annullér reklamationen, eller ret status.`;
    }
    if (handling === "anmeld") {
      return `Skaden kan ikke anmeldes, fordi ${grund}. Genindlæs siden.`;
    }
    if (handling === "udbetal") {
      return `Erstatningen kan ikke udbetales, fordi ${grund}. Ingen penge er flyttet.`;
    }
    return `Reklamationen kan ikke åbnes igen, fordi ${grund}. Vælg afvist, eller annullér.`;
  }
  return KODE[kode] ?? GENERISK;
}

function stier(sagId?: string, tradeId?: string) {
  revalidatePath("/admin/reklamationer");
  revalidatePath("/admin/sager");
  if (sagId) revalidatePath(adminSagSti(sagId));
  if (tradeId) revalidatePath(sagSti(tradeId));
}

function erAdgangsfejl(err: unknown): boolean {
  return err instanceof Error && ["Ingen adgang", "Ikke logget ind", "Kræver to-trins-login"].includes(err.message);
}

async function koer(
  navn: string,
  rpc: string,
  args: Record<string, unknown>,
  s: { sagId?: string; tradeId?: string } = {},
  handling?: "kvitter" | "anmeld",
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
    if (svar.kode !== "ok") return { fejl: fejlTekst(svar, handling) };
    // Besked til sælgeren med det samme - cron'en tager den ellers inden for
    // 5 minutter.
    after(() => notificerReklamationer());
    stier(s.sagId, s.tradeId);
    return svar.uaendret === true ? { ok: true, uaendret: true } : { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (erAdgangsfejl(err)) return { fejl: INGEN_ADGANG };
    console.error(`Reklamation: ${navn} fejlede:`, err);
    return { fejl: GENERISK };
  }
}

const sag = (sagId?: string) => ({ sagId: erUuid(sagId) ? sagId : undefined });

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
  }, sag(sagId));
}

// Staff har anmeldt skaden hos fragtfirmaet: fragtfirmaets sagsnummer
// (påkrævet). Kaldt igen på en anmeldt reklamation rettes sagsnummeret.
export async function anmeldReklamation(reklamationId: string, sagsnummer: string, sagId?: string): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  const nr = typeof sagsnummer === "string" ? sagsnummer.trim() : "";
  if (!nr) return { fejl: KODE.sagsnummer_mangler };
  return koer("anmeldReklamation", "fragt_reklamation_anmeld", { p_reklamation: reklamationId, p_sagsnummer: nr }, sag(sagId), "anmeld");
}

// Fragtfirmaet har godkendt: beløbet (dansk format, fx "1.250,00").
export async function godkendReklamation(reklamationId: string, beloebKr: string, sagId?: string): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  const b = fortolkKroner(String(beloebKr ?? ""));
  if ("fejl" in b) return { fejl: b.fejl };
  if (b.oere < REKLAMATION_MIN_OERE) return { fejl: REKLAMATION_MIN_TEKST };
  return koer("godkendReklamation", "fragt_reklamation_godkend", { p_reklamation: reklamationId, p_beloeb_oere: b.oere }, sag(sagId));
}

// Fragtfirmaet har afvist: grunden (vises for sælgeren - påkrævet).
export async function afvisReklamation(reklamationId: string, grund: string, sagId?: string): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  const g = typeof grund === "string" ? grund.trim() : "";
  if (!g) return { fejl: KODE.grund_mangler };
  return koer("afvisReklamation", "fragt_reklamation_afvis", { p_reklamation: reklamationId, p_grund: g }, sag(sagId));
}

export async function annullerReklamation(reklamationId: string, grund: string, sagId?: string): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  return koer("annullerReklamation", "fragt_reklamation_annuller", {
    p_reklamation: reklamationId,
    p_grund: typeof grund === "string" ? grund : "",
  }, sag(sagId));
}

// Sagen er ændret efter anmeldelsen: staff kvitterer ("set - reklamationen
// fortsætter"). begrundelse er intern og påkrævet.
export async function kvitterSagAendret(reklamationId: string, begrundelse: string, sagId?: string): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  return koer("kvitterSagAendret", "fragt_reklamation_kvitter_sag_aendret", {
    p_reklamation: reklamationId,
    p_begrundelse: typeof begrundelse === "string" ? begrundelse : "",
  }, sag(sagId), "kvitter");
}

// Ret status (fx forkert registreret). beloebKr kræves ved "godkendt" (dansk
// format), sagsnummer ved anmeldt/godkendt (hvis der ikke er et), grund ved
// afvist. begrundelse er intern og påkrævet.
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
    if (b.oere < REKLAMATION_MIN_OERE) return { fejl: REKLAMATION_MIN_TEKST };
    beloeb = b.oere;
  }
  return koer("retReklamationStatus", "fragt_reklamation_ret_status", {
    p_reklamation: input.reklamationId,
    p_status: input.status,
    p_beloeb_oere: beloeb,
    p_sagsnummer: typeof input.sagsnummer === "string" ? input.sagsnummer : null,
    p_grund: typeof input.grund === "string" ? input.grund : null,
    p_begrundelse: typeof input.begrundelse === "string" ? input.begrundelse : "",
  }, sag(input.sagId));
}

// --- Chefens udbetaling ------------------------------------------------------

// KUN chefen: erstatningen er modtaget fra fragtfirmaet -> hele det godkendte
// beløb sendes via Stripe fra BidHamrs platformssaldo til sælgerens
// Stripe-konto (og derfra til sælgerens bank). erstatningModtaget skal være
// true (flueben "Erstatningen er modtaget fra DAO" - logges med hvem/hvornår).
// Databasen tjekker rolle, aal2, inhabilitet, "sag ændret", betingelserne,
// nødstop, frysning og sælgerens konto (fragt_reklamation_udbetal_claim);
// derefter Stripe (src/lib/reklamation/udbetaling.ts).
export async function udbetalReklamation(
  reklamationId: string,
  valg: { erstatningModtaget: boolean },
  sagId?: string,
): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  if (valg?.erstatningModtaget !== true) return { fejl: KODE.bekraeftelse_mangler };
  let chefId: string | null = null;
  try {
    ({ userId: chefId } = await assertRole("chef"));
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("fragt_reklamation_udbetal_claim", {
      p_reklamation: reklamationId,
      p_erstatning_modtaget: true,
    });
    if (error) {
      if (["PGRST202", "42883"].includes(error.code ?? "")) {
        return { fejl: "Udbetaling kræver migrationen 20261029010000_reklamation_fragtfirma.sql." };
      }
      throw new Error(error.message);
    }
    const svar = (data ?? {}) as Record<string, unknown>;
    if (svar.kode !== "ok") return { fejl: fejlTekst(svar, "udbetal") };
    const claim = svar as unknown as UdbetalClaim;
    const res = await udfoerReklamationTransfer(reklamationId.toLowerCase(), {
      beloeb_oere: Number(claim.beloeb_oere),
      konto: String(claim.konto),
      forsoeg: Number(claim.forsoeg ?? 0),
      trade_id: String(claim.trade_id),
      sag_id: String(claim.sag_id),
      saelger_id: String(claim.saelger_id),
      sagsnummer: claim.sagsnummer ?? null,
      transportoer: String(claim.transportoer),
      genoptag: claim.genoptag === true,
      paabegyndt_kl: String(claim.paabegyndt_kl),
      oprettet_kl: String(claim.oprettet_kl),
    });
    stier(erUuid(sagId) ? sagId : String(claim.sag_id), String(claim.trade_id));
    if (res !== "udbetalt") return { fejl: TRANSFER[res] ?? GENERISK };
    // Videre til sælgerens bank og besked til sælgeren (fejl her ændrer ikke,
    // at pengene er sendt - cron'en prøver igen).
    after(async () => {
      try {
        await udbetalReklamationTilBank(reklamationId.toLowerCase());
      } catch (err) {
        await logDriftFejl({ kilde: "server", hvor: "reklamation/bank", fejl: err, brugerId: String(claim.saelger_id) });
      }
      await notificerReklamationer();
    });
    return { ok: true };
  } catch (err) {
    unstable_rethrow(err);
    if (erAdgangsfejl(err)) return { fejl: KODE.kun_chef };
    console.error("Reklamation: udbetalReklamation fejlede:", err);
    await logDriftFejl({ kilde: "action", hvor: "reklamation/udbetaling", fejl: err, brugerId: chefId });
    return {
      fejl: "Noget gik galt under udbetalingen. Det er uvist, om pengene er sendt – tryk igen om lidt (der udbetales aldrig to gange), eller se drift-loggen.",
    };
  }
}

// KUN chefen: udbetalingen af erstatningen til sælgerens bank er annulleret
// hos Stripe (BidHamr annullerer aldrig selv, så den sendes ikke automatisk
// igen - rød lampe). Chefen har set på det i Stripe og sender igen: databasen
// tjekker rolle, aal2 og inhabilitet med chefens session og nulstiller
// (fragt_reklamation_bank_send_igen, nyt forsøg = ny idempotency-nøgle);
// derefter sendes den ad den almindelige vej med alle dens værn
// (udbetalReklamationTilBank - cron'en tager den også, hvis den venter).
export async function sendReklamationTilBankIgen(reklamationId: string, sagId?: string): Promise<ReklamationSvar> {
  if (!erUuid(reklamationId)) return { fejl: KODE.ikke_fundet };
  let chefId: string | null = null;
  try {
    ({ userId: chefId } = await assertRole("chef"));
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("fragt_reklamation_bank_send_igen", { p_reklamation: reklamationId });
    if (error) {
      if (["PGRST202", "42883"].includes(error.code ?? "")) {
        return { fejl: "Kræver migrationen 20261029010000_reklamation_fragtfirma.sql." };
      }
      throw new Error(error.message);
    }
    const svar = (data ?? {}) as Record<string, unknown>;
    if (svar.kode !== "ok") return { fejl: fejlTekst(svar) };
    stier(erUuid(sagId) ? sagId : String(svar.sag_id), String(svar.trade_id));
    const res = await udbetalReklamationTilBank(reklamationId.toLowerCase());
    if (res === "oprettet" || res === "faerdig") return { ok: true };
    return { fejl: BANK[res] ?? GENERISK };
  } catch (err) {
    unstable_rethrow(err);
    if (erAdgangsfejl(err)) return { fejl: "Kun chefen kan sende erstatningen til banken igen." };
    console.error("Reklamation: sendReklamationTilBankIgen fejlede:", err);
    await logDriftFejl({ kilde: "action", hvor: "reklamation/bank", fejl: err, brugerId: chefId });
    return { fejl: "Noget gik galt. Det slås op og prøves igen automatisk – der udbetales aldrig to gange. Se drift-loggen." };
  }
}
