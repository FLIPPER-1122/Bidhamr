import "server-only";

// "Reklamationspakken": alt, hvad omdeling.info (DAO) eller GLS typisk beder
// om ved en skadeanmeldelse, samlet ét sted, så sælgeren kan kopiere felterne
// over og vedhæfte billederne med ét klik (Filip: færrest mulige klik).
//
// To modtagere:
//   "staff"   - alt, inkl. interne felter og købers kontaktoplysninger fra
//               leveringsvalget. Kalderen har tjekket assertRole/kraevSideRolle.
//   "saelger" - kun det, sælgeren må se: modtageren som på fragtlabelen
//               (navn og adresse fra forsendelsen - aldrig købers e-mail eller
//               telefon), ingen interne felter. Kalderen har tjekket
//               min_reklamationspakke_adgang med SÆLGERENS session (se
//               hentPakkeTilSaelger nedenfor).
// Bygges med service-role-klienten. Kaster ikke ved manglende billeder/
// sporing - felterne er så null/tomme.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { PAKKE_BUCKET, PAKKE_KATEGORI_NAVN, erPakkeBilledeKategori } from "@/lib/pakkebilleder";
import { SAG_BUCKET, SAG_KATEGORI_NAVN, erSagBilledeKategori } from "@/lib/sager";
import {
  REKLAMATION_ANMELD,
  kroner,
  transportoerNavn,
  type ReklamationTransportoer,
  type SaelgerReklamation,
  type StaffReklamation,
} from "@/lib/reklamation/typer";

const URL_SEK = 3600;

export type PakkeModtager = "staff" | "saelger";

export type PakkePart = {
  navn: string | null;
  adresse: string | null;
  postnummer: string | null;
  by: string | null;
  telefon: string | null;
  email: string | null;
};

export type PakkeHaendelse = { tidspunkt: string | null; type: string; beskrivelse: string | null };

export type PakkeBillede = {
  id: string;
  kilde: "saelger_pakke" | "koeber_skade";
  kategori: string;
  kategoriNavn: string;
  // Signeret link (1 time). null, hvis det ikke kunne laves.
  url: string | null;
  filnavn: string;
  oprettetKl: string;
};

export type Reklamationspakke = {
  reklamation: SaelgerReklamation;
  // Kun for staff.
  staff: StaffReklamation | null;
  transportoer: ReklamationTransportoer;
  transportoerNavn: string;
  anmeldUrl: string | null;
  anmeldTekst: string;
  trackingnummer: string | null;
  forsendelsesId: string | null;
  afsender: PakkePart;
  modtager: PakkePart;
  levering: string | null;
  pakkestoerrelse: string | null;
  vaegtGram: number | null;
  afsendtKl: string | null;
  leveretKl: string | null;
  varetitel: string | null;
  varebeskrivelse: string | null;
  varensVaerdiOere: number;
  kravbeloebOere: number;
  maksErstatningOere: number | null;
  skadebeskrivelse: string | null;
  sporingshistorik: PakkeHaendelse[];
  billeder: PakkeBillede[];
  // Færdig tekst til at indsætte i fragtfirmaets formular/mail.
  tekst: string;
};

// Til ZIP'en: hvor billederne ligger (vises aldrig - stien indeholder købers id).
export type PakkeFiler = { bucket: string; sti: string; filnavn: string; oprettetKl: string }[];

type Json = Record<string, unknown> | null;

const SAELGER_FELTER = [
  "id", "sag_id", "trade_id", "transportoer", "status", "trackingnummer", "varens_vaerdi_oere",
  "kravbeloeb_oere", "maks_erstatning_oere", "godkendt_beloeb_oere", "afvisningsgrund",
  "annulleret_grund", "transportoerens_sagsnummer", "oprettet_kl", "anmeldt_kl", "afgjort_kl",
  "fravalgt_kl", "annulleret_kl",
] as const;

function felt(j: Json, ...navne: string[]): string | null {
  if (!j) return null;
  for (const n of navne) {
    const v = j[n];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function part(j: Json, medKontakt: boolean): PakkePart {
  return {
    navn: felt(j, "navn", "name"),
    adresse: felt(j, "adresse", "address1"),
    postnummer: felt(j, "postnummer", "zipcode"),
    by: felt(j, "by", "city"),
    telefon: medKontakt ? felt(j, "telefon", "mobile") : null,
    email: medKontakt ? felt(j, "email") : null,
  };
}

function datoTid(iso: string | null): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    dateStyle: "short",
    timeStyle: "short",
  });
}

function partTekst(p: PakkePart): string {
  const by = [p.postnummer, p.by].filter(Boolean).join(" ");
  return [p.navn, p.adresse, by, p.telefon, p.email].filter(Boolean).join(", ") || "–";
}

function filnavn(kilde: PakkeBillede["kilde"], kategoriNavn: string, sti: string, nr: number): string {
  const endelse = (/\.([a-z0-9]{2,5})$/i.exec(sti)?.[1] ?? "jpg").toLowerCase();
  const k = kilde === "saelger_pakke" ? "afsender-indpakning" : "modtager-skade";
  const kat = kategoriNavn
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${String(nr).padStart(2, "0")}-${k}-${kat}.${endelse}`;
}

function byggTekst(p: Omit<Reklamationspakke, "tekst">): string {
  const antal = (k: PakkeBillede["kilde"]) => p.billeder.filter((b) => b.kilde === k).length;
  const linjer = [
    `Skadeanmeldelse – pakke sendt med ${p.transportoerNavn}`,
    "",
    `Trackingnummer: ${p.trackingnummer ?? "–"}`,
    p.forsendelsesId ? `Forsendelses-id: ${p.forsendelsesId}` : null,
    `Afsender: ${partTekst(p.afsender)}`,
    `Modtager: ${partTekst(p.modtager)}`,
    `Afsendt: ${datoTid(p.afsendtKl)}`,
    `Leveret: ${datoTid(p.leveretKl)}`,
    "",
    `Indhold: ${p.varetitel ?? "–"}`,
    `Varens værdi: ${kroner(p.varensVaerdiOere)}`,
    `Krav: ${kroner(p.kravbeloebOere)}`,
    "",
    "Skadebeskrivelse (fra modtageren):",
    p.skadebeskrivelse ?? "–",
    "",
    `Vedlagt: ${antal("saelger_pakke")} billeder af indpakningen (taget af afsenderen før afsendelse) og ${antal("koeber_skade")} billeder af skaden (taget af modtageren).`,
  ];
  return linjer.filter((l) => l !== null).join("\n");
}

// Bygger pakken. null = reklamationen findes ikke.
export async function hentReklamationspakke(
  admin: SupabaseClient,
  reklamationId: string,
  til: PakkeModtager,
): Promise<{ pakke: Reklamationspakke; filer: PakkeFiler } | null> {
  const { data: r, error } = await admin
    .from("fragt_reklamationer")
    .select("*")
    .eq("id", reklamationId)
    .maybeSingle<StaffReklamation>();
  if (error) throw new Error(`Reklamationen kunne ikke hentes: ${error.message}`);
  if (!r) return null;
  const erStaff = til === "staff";

  const [sagR, handelR, fR, levR, pakkeR, sagBR] = await Promise.all([
    admin.from("sager").select("beskrivelse").eq("id", r.sag_id).maybeSingle<{ beskrivelse: string }>(),
    admin
      .from("trades")
      .select("auction_id, sendt_kl, received_at")
      .eq("id", r.trade_id)
      .maybeSingle<{ auction_id: string | null; sendt_kl: string | null; received_at: string | null }>(),
    r.forsendelse_id
      ? admin
          .from("forsendelser")
          .select(
            "id, sporingsnummer, forsendelses_id, afsender, modtager, levering, pakkestoerrelse, vaegt_gram, afleveret_kl, leveret_kl",
          )
          .eq("id", r.forsendelse_id)
          .maybeSingle<{
            id: string;
            sporingsnummer: string | null;
            forsendelses_id: string | null;
            afsender: Json;
            modtager: Json;
            levering: string | null;
            pakkestoerrelse: string | null;
            vaegt_gram: number | null;
            afleveret_kl: string | null;
            leveret_kl: string | null;
          }>()
      : Promise.resolve({ data: null }),
    // Købers leveringsvalg (med kontaktoplysninger) - KUN til staff.
    erStaff
      ? admin
          .from("handel_levering")
          .select("modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, modtager_email")
          .eq("trade_id", r.trade_id)
          .maybeSingle<Record<string, string | null>>()
      : Promise.resolve({ data: null }),
    admin
      .from("pakke_billeder")
      .select("id, sti, kategori, oprettet_kl")
      .eq("trade_id", r.trade_id)
      .order("oprettet_kl", { ascending: true })
      .limit(20),
    admin
      .from("sag_billeder")
      .select("id, sti, kategori, oprettet_kl")
      .eq("sag_id", r.sag_id)
      .order("oprettet_kl", { ascending: true })
      .limit(30),
  ]);

  const handel = handelR.data;
  const f = fR.data;

  const [auktionR, haendR] = await Promise.all([
    handel?.auction_id
      ? admin
          .from("auctions")
          .select("titel, beskrivelse, maerke, stand")
          .eq("id", handel.auction_id)
          .maybeSingle<{ titel: string | null; beskrivelse: string | null; maerke: string | null; stand: string | null }>()
      : Promise.resolve({ data: null }),
    f
      ? admin
          .from("forsendelse_haendelser")
          .select("tidspunkt, type, beskrivelse")
          .eq("forsendelse_id", f.id)
          .order("tidspunkt", { ascending: true })
          .limit(100)
      : Promise.resolve({ data: [] }),
  ]);
  const auktion = auktionR.data;

  // Modtager: som på fragtlabelen (forsendelsen). Staff får også købers
  // telefon/e-mail og leveringsvalget som reserve.
  let modtager = part(f?.modtager ?? null, erStaff);
  const lev = levR.data;
  if (erStaff && lev) {
    modtager = {
      navn: modtager.navn ?? lev.modtager_navn ?? null,
      adresse: modtager.adresse ?? lev.modtager_adresse ?? null,
      postnummer: modtager.postnummer ?? lev.modtager_postnummer ?? null,
      by: modtager.by ?? lev.modtager_by ?? null,
      telefon: modtager.telefon ?? lev.modtager_telefon ?? null,
      email: modtager.email ?? lev.modtager_email ?? null,
    };
  }

  type BRaekke = { id: string; sti: string; kategori: string; oprettet_kl: string };
  const pakkeRaekker = ((pakkeR.data ?? []) as BRaekke[]).filter((b) => erPakkeBilledeKategori(b.kategori));
  const sagRaekker = ((sagBR.data ?? []) as BRaekke[]).filter((b) => erSagBilledeKategori(b.kategori));

  const signer = async (bucket: string, stier: string[]) => {
    const m = new Map<string, string>();
    if (stier.length === 0) return m;
    const { data } = await admin.storage.from(bucket).createSignedUrls(stier, URL_SEK);
    for (const s of data ?? []) if (s.path && s.signedUrl) m.set(s.path, s.signedUrl);
    return m;
  };
  const [pakkeUrls, sagUrls] = await Promise.all([
    signer(PAKKE_BUCKET, pakkeRaekker.map((b) => b.sti)),
    signer(SAG_BUCKET, sagRaekker.map((b) => b.sti)),
  ]);

  const billeder: PakkeBillede[] = [];
  const filer: PakkeFiler = [];
  let nr = 0;
  const tilfoej = (b: BRaekke, kilde: PakkeBillede["kilde"], kategoriNavn: string, bucket: string, url?: string) => {
    nr++;
    const navn = filnavn(kilde, kategoriNavn, b.sti, nr);
    billeder.push({ id: b.id, kilde, kategori: b.kategori, kategoriNavn, url: url ?? null, filnavn: navn, oprettetKl: b.oprettet_kl });
    filer.push({ bucket, sti: b.sti, filnavn: navn, oprettetKl: b.oprettet_kl });
  };
  for (const b of pakkeRaekker) {
    tilfoej(b, "saelger_pakke", PAKKE_KATEGORI_NAVN[b.kategori as keyof typeof PAKKE_KATEGORI_NAVN], PAKKE_BUCKET, pakkeUrls.get(b.sti));
  }
  for (const b of sagRaekker) {
    tilfoej(b, "koeber_skade", SAG_KATEGORI_NAVN[b.kategori as keyof typeof SAG_KATEGORI_NAVN], SAG_BUCKET, sagUrls.get(b.sti));
  }

  const varebeskrivelse =
    [
      auktion?.maerke ? `Mærke: ${auktion.maerke}` : null,
      auktion?.stand ? `Stand: ${auktion.stand}` : null,
      auktion?.beskrivelse ?? null,
    ]
      .filter(Boolean)
      .join("\n") || null;

  const offentlig = Object.fromEntries(SAELGER_FELTER.map((k) => [k, r[k]])) as SaelgerReklamation;
  const anmeld = REKLAMATION_ANMELD[r.transportoer];

  const uden: Omit<Reklamationspakke, "tekst"> = {
    reklamation: offentlig,
    staff: erStaff ? r : null,
    transportoer: r.transportoer,
    transportoerNavn: transportoerNavn(r.transportoer),
    anmeldUrl: anmeld?.url ?? null,
    anmeldTekst: anmeld?.tekst ?? "",
    trackingnummer: r.trackingnummer ?? f?.sporingsnummer ?? null,
    forsendelsesId: f?.forsendelses_id ?? null,
    afsender: part(f?.afsender ?? null, true),
    modtager,
    levering: f?.levering ?? null,
    pakkestoerrelse: f?.pakkestoerrelse ?? null,
    vaegtGram: f?.vaegt_gram ?? null,
    afsendtKl: f?.afleveret_kl ?? handel?.sendt_kl ?? null,
    leveretKl: f?.leveret_kl ?? handel?.received_at ?? null,
    varetitel: auktion?.titel ?? null,
    varebeskrivelse,
    varensVaerdiOere: r.varens_vaerdi_oere,
    kravbeloebOere: r.kravbeloeb_oere,
    maksErstatningOere: r.maks_erstatning_oere,
    skadebeskrivelse: sagR.data?.beskrivelse ?? null,
    sporingshistorik: ((haendR.data ?? []) as PakkeHaendelse[]).map((h) => ({
      tidspunkt: h.tidspunkt,
      type: h.type,
      beskrivelse: h.beskrivelse,
    })),
    billeder,
  };
  return { pakke: { ...uden, tekst: byggTekst(uden) }, filer };
}

// Sælgerens adgang: tjekkes i databasen med SÆLGERENS egen klient (cookie-
// session eller Bearer-token fra appen) - auth.uid() afgør. Pakken bygges
// derefter med service-role uden købers kontaktoplysninger.
// null = ingen adgang (ikke din, findes ikke eller er lukket).
export async function hentPakkeTilSaelger(
  brugerKlient: SupabaseClient,
  reklamationId: string,
): Promise<{ pakke: Reklamationspakke; filer: PakkeFiler } | null> {
  const { data, error } = await brugerKlient.rpc("min_reklamationspakke_adgang", { p_reklamation: reklamationId });
  if (error) throw new Error(`min_reklamationspakke_adgang fejlede: ${error.message}`);
  if (data !== true) return null;
  return hentReklamationspakke(createAdminClient(), reklamationId, "saelger");
}
