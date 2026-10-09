import "server-only";

// DAC7 på serveren: sælgerens oplysninger (CPR krypteres her, før det rammer
// databasen), cron-beskeder, chefens indberetningsfil og "sendt"-markering.
// Databasen: supabase/migrations/20261014010000_dac7.sql. Se docs/DAC7.md.
//
// CPR-nummeret i klar tekst findes kun i hukommelsen her - det logges aldrig,
// sendes aldrig i en mail og gemmes aldrig ukrypteret.

import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";
import { logDriftFejl } from "@/lib/drift";
import { dekrypter, krypter, krypteringKlar } from "@/lib/dac7/krypto";
import { byggDac7Csv, type EksportSaelger, type Kvartal } from "@/lib/dac7/csv";
import {
  cprPasserMedFoedselsdato,
  delNavn,
  erEuLand,
  gyldigAdresse,
  gyldigBynavn,
  gyldigPostnummer,
  maskerCpr,
  normaliserCpr,
  normaliserTin,
} from "@/lib/dac7/regler";
import { DAC7 } from "@/lib/dac7/tekster";

type Admin = ReturnType<typeof createAdminClient>;

export type Dac7Status = {
  aar: number;
  konto_type: "privat" | "erhverv";
  antal: number;
  vederlag_oere: number;
  gebyr_oere: number;
  graense_antal: number;
  graense_oere: number;
  varsel_antal: number;
  varsel_oere: number;
  pligtig: boolean;
  naer: boolean;
  mangler: string[];
  mitid: { navn: string | null; foedselsdato: string | null } | null;
  oplysninger: {
    adresse: string;
    postnummer: string;
    bynavn: string;
    land: string;
    cpr_oplyst: boolean;
    andet_tin_land: string | null;
    oplyst_kl: string;
    opdateret_kl: string;
  } | null;
  anmodning: { aar: number; anmodet_kl: string; frist: string; paamindelser: number; spaerret: boolean } | null;
  indberetninger: { aar: number; indberettet_kl: string; data: Indberetning }[];
};

export type Indberetning = {
  konto_type: "privat" | "erhverv";
  navn: string | null;
  foedselsdato: string | null;
  cvr: string | null;
  adresse: string | null;
  postnummer: string | null;
  bynavn: string | null;
  land: string;
  cpr_oplyst: boolean;
  andet_tin_land: string | null;
  antal: number;
  vederlag_oere: number;
  gebyr_oere: number;
  kvartaler: { antal: number; vederlag_oere: number; gebyr_oere: number }[];
  valuta: string;
};

export function datoDansk(iso: string): string {
  return new Date(iso).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Copenhagen",
  });
}

// Den indloggede brugers status (auth.uid() i databasen). null ved fejl.
export async function hentMinDac7Status(
  supabase: { rpc: (fn: string) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
): Promise<Dac7Status | null> {
  const { data, error } = await supabase.rpc("dac7_min_status");
  if (error) {
    console.error("dac7_min_status fejlede:", error.message);
    return null;
  }
  return (data as Dac7Status | null) ?? null;
}

// Brugerens eget CPR, maskeret (kun fødselsdato-delen), til "Min konto".
// brugerId SKAL være den indloggede bruger (kaldes kun med auth-brugerens id).
export async function hentMitMaskeredeCpr(brugerId: string, aar?: number): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } =
    aar === undefined
      ? await admin.rpc("dac7_cpr_krypteret", { p_bruger: brugerId })
      : await admin.rpc("dac7_kopi_cpr_krypteret", { p_bruger: brugerId, p_aar: aar });
  if (error || typeof data !== "string") return null;
  return maskerCpr(dekrypter(data, brugerId, "cpr"));
}

export type GemInput = {
  adresse: unknown;
  postnummer: unknown;
  bynavn: unknown;
  cpr: unknown; // tom = behold det gemte
  andetTinLand: unknown; // tom = intet
  andetTinNummer: unknown;
  beholdAndetTin: unknown; // true = behold det gemte andet skatte-id uændret
  bekraeft: unknown;
};

export type GemSvar = { ok: true } | { fejl: string; kode: string; felt?: string };

const s = (v: unknown) => (typeof v === "string" ? v : "");

// Gemmer sælgerens oplysninger. Validerer, tjekker CPR mod fødselsdatoen fra
// MitID og krypterer CPR/TIN, før de sendes til databasen.
export async function gemSkatteoplysninger(brugerId: string, input: GemInput): Promise<GemSvar> {
  const F = DAC7.fejl;
  if (!krypteringKlar()) return { fejl: F.ikkeTilgaengelig, kode: "ikke_tilgaengelig" };
  if (input.bekraeft !== true) return { fejl: F.bekraeft, kode: "ugyldig", felt: "bekraeft" };

  const adresse = s(input.adresse).trim();
  const postnummer = s(input.postnummer).trim();
  const bynavn = s(input.bynavn).trim();
  if (!gyldigAdresse(adresse)) return { fejl: F.adresse, kode: "ugyldig", felt: "adresse" };
  if (!gyldigPostnummer(postnummer)) return { fejl: F.postnummer, kode: "ugyldig", felt: "postnummer" };
  if (!gyldigBynavn(bynavn)) return { fejl: F.bynavn, kode: "ugyldig", felt: "bynavn" };

  const admin = createAdminClient();
  const { data: mitid, error: mFejl } = await admin
    .from("mitid_verificeringer")
    .select("foedselsdato")
    .eq("bruger_id", brugerId)
    .eq("status", "aktiv")
    .maybeSingle<{ foedselsdato: string | null }>();
  if (mFejl) throw new Error(`mitid_verificeringer: ${mFejl.message}`);
  if (!mitid?.foedselsdato) return { fejl: F.mitid, kode: "mitid" };

  let cprKrypteret: string | null = null;
  const cprRaa = s(input.cpr).trim();
  if (cprRaa) {
    const cpr = normaliserCpr(cprRaa);
    if (!cpr) return { fejl: F.cpr, kode: "ugyldig", felt: "cpr" };
    if (!cprPasserMedFoedselsdato(cpr, mitid.foedselsdato)) {
      return { fejl: F.cprFoedselsdato, kode: "ugyldig", felt: "cpr" };
    }
    cprKrypteret = krypter(cpr, brugerId, "cpr");
  }

  const behold = input.beholdAndetTin === true;
  let andetLand: string | null = null;
  let andetKrypteret: string | null = null;
  if (!behold) {
    const land = s(input.andetTinLand).trim().toUpperCase();
    const nummerRaa = s(input.andetTinNummer);
    if (land || nummerRaa.trim()) {
      const nummer = normaliserTin(nummerRaa);
      if (!erEuLand(land) || !nummer) return { fejl: F.andetTin, kode: "ugyldig", felt: "andetTin" };
      andetLand = land;
      andetKrypteret = krypter(nummer, brugerId, "andet_tin");
    }
  }

  const { data, error } = await admin.rpc("dac7_gem_oplysninger", {
    p_bruger: brugerId,
    p_adresse: adresse,
    p_postnummer: postnummer,
    p_bynavn: bynavn,
    p_land: "DK",
    p_cpr_krypteret: cprKrypteret,
    p_andet_tin_land: andetLand,
    p_andet_tin_krypteret: andetKrypteret,
    p_behold_andet: behold,
  });
  // Kun fejlkoden - Postgres' tekst kan indeholde rækkens værdier (adresse).
  if (error) throw new Error(`dac7_gem_oplysninger fejlede: ${error.code ?? "ukendt"}`);
  const kode = (data as { kode?: string } | null)?.kode ?? "fejl";
  if (kode === "ok") return { ok: true };
  if (kode === "cpr_mangler") return { fejl: F.cprMangler, kode: "ugyldig", felt: "cpr" };
  if (kode === "mitid") return { fejl: F.mitid, kode: "mitid" };
  if (kode === "erhverv") return { fejl: F.erhverv, kode: "erhverv" };
  return { fejl: F.generisk, kode: "fejl" };
}

// --- Cron --------------------------------------------------------------------

type CronBesked = { bruger_id: string; aar: number; trin: string; frist: string };

// Anmodninger, påmindelser og spærring (højst én gang i timen i databasen).
// Beskeden sendes med en nøgle pr. trin, så den aldrig sendes to gange.
export async function koerDac7Cron(): Promise<{ sendt: number; nye: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("dac7_koer_cron", { p_tving: false });
  if (error) {
    // Før migrationen findes funktionen ikke - ingen alarm.
    if (error.code === "PGRST202" || error.code === "42883") return { sendt: 0, nye: 0 };
    throw new Error(`dac7_koer_cron: ${error.message}`);
  }
  const r = (data ?? {}) as { sprunget?: boolean; nye?: number; beskeder?: CronBesked[] };
  let sendt = 0;
  for (const b of r.beskeder ?? []) {
    const frist = datoDansk(b.frist);
    const indhold =
      b.trin === "anmodning"
        ? DAC7.besked.anmodning(frist)
        : b.trin === "paamindelse_1"
          ? DAC7.besked.paamindelse(1, frist)
          : b.trin === "paamindelse_2"
            ? DAC7.besked.paamindelse(2, frist)
            : b.trin === "spaerret"
              ? DAC7.besked.spaerret
              : null;
    if (!indhold) continue;
    const res = await send(
      b.bruger_id,
      "skat",
      { ...indhold, link: "/konto/skat", noegle: `dac7:${b.aar}:${b.trin}:${b.bruger_id}` },
      { springOverVedClaimFejl: true },
    );
    if (!res.dublet && (res.klokke || res.mail || res.push)) sendt++;
  }
  return { sendt, nye: r.nye ?? 0 };
}

// --- Chef: indberetningsfil -----------------------------------------------------

type EksportRaekke = {
  bruger_id: string;
  konto_type: "privat" | "erhverv";
  kvartaler: { antal: number; vederlag_oere: number; gebyr_oere: number }[];
  juridisk_navn: string | null;
  foedselsdato: string | null;
  adresse: string | null;
  postnummer: string | null;
  bynavn: string | null;
  land: string | null;
  cpr_krypteret: string | null;
  andet_tin_land: string | null;
  andet_tin_krypteret: string | null;
  firmanavn: string | null;
  cvr: string | null;
  firma_adresse: string | null;
  firma_postnummer: string | null;
  firma_bynavn: string | null;
  mangler: string[];
};

type PlatformRaekke = {
  cvr: string | null;
  navn: string | null;
  vej: string | null;
  postnummer: string | null;
  bynavn: string | null;
  kontakt: string | null;
};

export type EksportSvar =
  | { ok: true; fil: string; filnavn: string; antal: number; ufuldstaendige: number; ulaeselige: number }
  | { fejl: string };

// Bygger Skattestyrelsens CSV for et år. Kun chef (tjekkes i databasen OG af
// kalderen). CPR dekrypteres kun her, i hukommelsen.
export async function lavIndberetningsfil(medarbejderId: string, aar: number): Promise<EksportSvar> {
  if (!krypteringKlar()) return { fejl: "DAC7_KRYPTERINGSNOEGLE mangler på serveren - CPR-numrene kan ikke læses." };
  const admin: Admin = createAdminClient();
  const { data, error } = await admin.rpc("dac7_admin_eksport", { p_medarbejder: medarbejderId, p_aar: aar });
  if (error) throw new Error(`dac7_admin_eksport: ${error.message}`);
  const r = data as { kode: string; platform: PlatformRaekke | null; saelgere: EksportRaekke[] };
  if (r.kode === "ingen_adgang") return { fejl: "Kun chefen kan hente indberetningsfilen." };
  const po = r.platform;
  if (!po?.cvr || !po.navn) {
    return { fejl: "Udfyld BidHamrs CVR-nummer og navn under Indstillinger først." };
  }

  let ufuldstaendige = 0;
  let ulaeselige = 0;
  const saelgere: EksportSaelger[] = r.saelgere.map((x) => {
    const docRefId = `DK${aar}${po.cvr}S${x.bruger_id.replace(/-/g, "")}`;
    const kvartaler: Kvartal[] = x.kvartaler.map((q) => ({
      antal: q.antal,
      vederlagOere: q.vederlag_oere,
      gebyrOere: q.gebyr_oere,
    }));
    if (x.mangler.length > 0) ufuldstaendige++;
    if (x.konto_type === "erhverv") {
      return {
        type: "erhverv",
        docRefId,
        navn: x.firmanavn,
        cvr: x.cvr,
        adresse: { vej: x.firma_adresse, postnummer: x.firma_postnummer, bynavn: x.firma_bynavn, land: "DK" },
        kvartaler,
      };
    }
    const cpr = dekrypter(x.cpr_krypteret, x.bruger_id, "cpr");
    if (x.cpr_krypteret && !cpr) ulaeselige++;
    const andet = x.andet_tin_land ? dekrypter(x.andet_tin_krypteret, x.bruger_id, "andet_tin") : null;
    if (x.andet_tin_krypteret && !andet) ulaeselige++;
    const navn = x.juridisk_navn ? delNavn(x.juridisk_navn) : null;
    return {
      type: "privat",
      docRefId,
      fornavn: navn?.fornavn ?? null,
      efternavn: navn?.efternavn ?? null,
      foedselsdato: x.foedselsdato,
      cpr,
      andetTin: andet && x.andet_tin_land ? { land: x.andet_tin_land, tin: andet } : null,
      adresse: { vej: x.adresse, postnummer: x.postnummer, bynavn: x.bynavn, land: x.land ?? "DK" },
      kvartaler,
    };
  });

  const nu = new Date();
  const beskedRef = `BH${nu.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const fil = byggDac7Csv({
    aar,
    beskedRef,
    platform: {
      cvr: po.cvr,
      navn: po.navn,
      vej: po.vej,
      postnummer: po.postnummer,
      bynavn: po.bynavn,
      kontakt: po.kontakt,
    },
    saelgere,
  });
  return {
    ok: true,
    fil,
    filnavn: `dac7-bidhamr-${aar}-${beskedRef}.csv`,
    antal: saelgere.length,
    ufuldstaendige,
    ulaeselige,
  };
}

// "Sendt til Skattestyrelsen": markerer året, gemmer kopierne og giver hver
// indberettet sælger besked (DAC7 kræver, at sælgeren får en kopi).
export async function markerIndberetningSendt(
  medarbejderId: string,
  aar: number,
  kvittering: string,
): Promise<{ ok: true; antal: number } | { kode: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("dac7_admin_marker_sendt", {
    p_medarbejder: medarbejderId,
    p_aar: aar,
    p_kvittering: kvittering,
  });
  if (error) throw new Error(`dac7_admin_marker_sendt: ${error.message}`);
  const r = data as { kode: string; antal?: number; brugere?: string[] };
  if (r.kode !== "ok") return { kode: r.kode };
  const besked = DAC7.besked.indberettet(aar);
  for (const brugerId of r.brugere ?? []) {
    try {
      await send(brugerId, "skat", { ...besked, link: "/konto/skat", noegle: `dac7:${aar}:indberettet:${brugerId}` });
    } catch (err) {
      await logDriftFejl({ kilde: "server", sti: "/admin/dac7", hvor: "DAC7: besked om indberetning", fejl: err });
    }
  }
  return { ok: true, antal: r.antal ?? 0 };
}
