// Klager over firmaer (reklamation) - fælles for køber, firma og admin.
// Ingen server-only-import: må bruges i klientkomponenter.
//
// Databasen: supabase/migrations/20261016020000_erhverv_klager.sql.
// Alle regler håndhæves dér (også for appen). Tallene her er kun til
// formularer og visning og skal følge migrationen.
//
// Appen (Expo) kan bruge det samme direkte med supabase-js (køberen):
//   supabase.rpc("erhverv_klager_handel", { p_trade })
//     -> null (ikke købers handel / sælgeren er ikke et firma) |
//        { kan_klage, grund, annulleret_afvist, klager: [{ id, nummer, kategori,
//          beskrivelse, status, afgoerelse, begrundelse, oprettet_kl, afgjort_kl,
//          billeder: [sti] }] }
//     annulleret_afvist = true: annulleret handel, hvor klage ikke er tilladt -
//     skjul knappen og vis KLAGE_KOEBER.annulleret.
//   Billeder (valgfri, højst 6): upload til "erhverv-klage-billeder" under
//     <eget id>/<handel-id>/<uuid>.jpg med { upsert: false }.
//   supabase.rpc("erhverv_klage_opret", { p_trade, p_kategori, p_beskrivelse, p_billeder: [{ sti }] })
//     -> { kode: "ok", klage_id, nummer }. Fejl: errcode BHE11-BHE14 med en
//        dansk besked efter præfikset (se klageFejlTekst).
//        Annulleret handel: BHE11 "erhverv_klage_annulleret: ..." - kun tilladt,
//        når betalinger.refusion_aarsag er 'afsendelsesfrist' eller 'sag'
//        (20261020020000). Vis KLAGE_KOEBER.annulleret.
//   supabase.rpc("erhverv_klage_traek_tilbage", { p_klage }) -> { kode: "ok" | "afsluttet" }
// Firmaet:
//   supabase.rpc("firma_klager") -> null | { berettigede_12_mdr, klager: [{ id, nummer,
//     trade_id, titel, kategori, status, afgoerelse, begrundelse, oprettet_kl, afgjort_kl }] }

import { KLAGE_KOEBER } from "@/lib/tekster/erhvervKlager";

export const KLAGE_BUCKET = "erhverv-klage-billeder";
export const KLAGE_MAKS_BILLEDER = 6;
export const KLAGE_BESKRIVELSE_MIN = 20;
export const KLAGE_BESKRIVELSE_MAKS = 4000;
export const KLAGE_BEGRUNDELSE_MAKS = 2000;
export const KLAGE_NOTE_MAKS = 4000;
export const KLAGE_ADVARSEL_BEGRUNDELSE_MAKS = 1000;

// Forslagsreglen (chefens valg - til Filips godkendelse). Spejlet i
// erhverv_klage_vurder_forslag.
export const KLAGE_FORSLAG_ANTAL = 3;
export const KLAGE_FORSLAG_MAANEDER = 12;

export const KLAGE_KATEGORIER = [
  "ikke_som_beskrevet",
  "ikke_leveret",
  "reklamation_afvist",
  "fortrydelsesret",
  "andet",
] as const;
export type KlageKategori = (typeof KLAGE_KATEGORIER)[number];

export const KLAGE_STATUSSER = ["aaben", "under_behandling", "afsluttet"] as const;
export type KlageStatus = (typeof KLAGE_STATUSSER)[number];

export type KlageAfgoerelse = "berettiget" | "ikke_berettiget" | "trukket_tilbage";
export type KlageNoteType = "note" | "kontakt_firma";
export type KlageKanal = "telefon" | "email" | "andet";

export function erKlageKategori(v: unknown): v is KlageKategori {
  return typeof v === "string" && (KLAGE_KATEGORIER as readonly string[]).includes(v);
}
export function erKlageStatus(v: unknown): v is KlageStatus {
  return typeof v === "string" && (KLAGE_STATUSSER as readonly string[]).includes(v);
}
export function erKlageKanal(v: unknown): v is KlageKanal {
  return v === "telefon" || v === "email" || v === "andet";
}

// Køberens egen klage (erhverv_klager_handel).
export type MinKlage = {
  id: string;
  nummer: number;
  kategori: KlageKategori;
  beskrivelse: string;
  status: KlageStatus;
  afgoerelse: KlageAfgoerelse | null;
  begrundelse: string | null;
  oprettet_kl: string;
  afgjort_kl: string | null;
  billeder: string[];
};

export type KlageGrund =
  | "aaben_findes"
  | "for_mange"
  | "for_mange_handel"
  | "ikke_betalt"
  | "for_sent";

export type KlagerPaaHandel = {
  kan_klage: boolean;
  grund: KlageGrund | null;
  // Annulleret handel, hvor klage ikke er tilladt (20261020020000). Kan
  // mangle, hvis migrationen ikke er kørt endnu.
  annulleret_afvist?: boolean;
  klager: MinKlage[];
};

// Firmaets visning (firma_klager) - uden købers oplysninger.
export type FirmaKlage = {
  id: string;
  nummer: number;
  trade_id: string;
  titel: string | null;
  kategori: KlageKategori;
  status: KlageStatus;
  afgoerelse: KlageAfgoerelse | null;
  begrundelse: string | null;
  oprettet_kl: string;
  afgjort_kl: string | null;
};

export type FirmaKlager = {
  berettigede_12_mdr: number;
  klager: FirmaKlage[];
};

// Fejl fra erhverv_klage_opret / erhverv_klage_traek_tilbage (BHE11-BHE14).
// Databasens besked efter præfikset er allerede dansk og vises direkte.
const KLAGE_PRAEFIKSER = [
  "erhverv_klage_ikke_tilladt",
  "erhverv_klage_findes",
  "erhverv_klage_for_mange",
  "erhverv_klage_ugyldig",
] as const;
const KLAGE_KODER = new Set(["BHE11", "BHE12", "BHE13", "BHE14"]);

export function klageFejlTekst(besked: string | null | undefined, kode?: string | null): string | null {
  const b = besked ?? "";
  // Annulleret handel (20261020020000): fast tekst, så hjemmesiden og appen
  // siger det samme, uanset databasens ordlyd.
  if (b.includes("erhverv_klage_annulleret:")) return KLAGE_KOEBER.annulleret;
  for (const p of KLAGE_PRAEFIKSER) {
    const i = b.indexOf(`${p}:`);
    if (i >= 0) {
      const tekst = b.slice(i + p.length + 1).trim();
      if (tekst) return tekst;
    }
  }
  if (kode && KLAGE_KODER.has(kode)) return "Klagen kunne ikke oprettes. Opdater siden, og prøv igen.";
  return null;
}
