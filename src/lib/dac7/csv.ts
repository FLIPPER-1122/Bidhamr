// Indberetningsfilen til Skattestyrelsen (DAC7) i deres CSV-format.
//
// Kilde: Skattestyrelsens "DAC7 indberetningsvejledning" v1.2 (afsnit 4) og
// CSV-skabelonen "csv-skabelon-til-dac7-indberetning.csv" (skat.dk/dac7):
// semikolon-separeret, UTF-8 med BOM, CRLF, én overskriftslinje med de 89
// kolonner herunder. Én række pr. rækketype (ROW_TYPE). Filen uploades i
// TastSelv Erhverv → Øvrige indberetninger → Platformsøkonomi, som validerer
// formatet ved upload (se docs/DAC7.md).
//
// Ren funktion (ingen hemmeligheder, ingen netværk) - kan testes alene.

export const KOLONNER = [
  "ROW_TYPE", "MSG_MESSAGE_REF_ID", "PO_DOC_REF_ID", "AD_DOC_REF_ID", "AG_DOC_REF_ID", "RS_DOC_REF_ID",
  "MSG_SENDING_ENTITY_IN", "MSG_WARNING", "MSG_CONTACT", "MSG_MESSAGE_TYPE_INDIC", "MSG_REPORTING_PERIOD",
  "MSG_VERSION", "DOC_TYPE_INDIC", "CORR_DOC_REF_ID", "RESIDENCE", "TIN", "TIN_ISSUED_BY", "TIN_UNKNOWN",
  "ADDR_FREE", "ADDR_STREET", "ADDR_BUILDING", "ADDR_SUITE", "ADDR_FLOOR", "ADDR_DISTRICT", "ADDR_POB",
  "ADDR_POST_CODE", "ADDR_CITY", "ADDR_COUNTRY_SUB_ENTITY", "ADDR_COUNTRY", "ADDR_LEGAL_ADDRESS_TYPE", "IN",
  "IN_ISSUED_BY", "IN_TYPE", "ORGANISATION_NAME", "PO_NEXUS", "PO_ASSUMED_REPORTING", "VAT", "BUSINESS_NAME",
  "RS_PERM_ESTABLISHMENT", "RS_FI_ACCT_NUMBER", "RS_FI_ACCT_NUMBER_TYPE", "RS_FI_ACCT_HOLDER_NAME",
  "RS_FI_OTHER_INFO", "RS_BIRTH_DATE", "RS_BIRTH_PLACE_CITY", "RS_BIRTH_PLACE_CITY_SUB_ENTITY",
  "RS_BIRTH_COUNTRY", "RS_BIRTH_FORMER_COUNTRY_NAME", "RS_NM_FIRST_NAME", "RS_NM_MIDDLE_NAME",
  "RS_NM_LAST_NAME", "RS_NM_GENERAL_SUFFIX",
  "RS_ACT_NUM_Q1", "RS_ACT_CONS_Q1", "RS_ACT_CONS_Q1_CCY", "RS_ACT_FEES_Q1", "RS_ACT_FEES_Q1_CCY", "RS_ACT_TAX_Q1", "RS_ACT_TAX_Q1_CCY",
  "RS_ACT_NUM_Q2", "RS_ACT_CONS_Q2", "RS_ACT_CONS_Q2_CCY", "RS_ACT_FEES_Q2", "RS_ACT_FEES_Q2_CCY", "RS_ACT_TAX_Q2", "RS_ACT_TAX_Q2_CCY",
  "RS_ACT_NUM_Q3", "RS_ACT_CONS_Q3", "RS_ACT_CONS_Q3_CCY", "RS_ACT_FEES_Q3", "RS_ACT_FEES_Q3_CCY", "RS_ACT_TAX_Q3", "RS_ACT_TAX_Q3_CCY",
  "RS_ACT_NUM_Q4", "RS_ACT_CONS_Q4", "RS_ACT_CONS_Q4_CCY", "RS_ACT_FEES_Q4", "RS_ACT_FEES_Q4_CCY", "RS_ACT_TAX_Q4", "RS_ACT_TAX_Q4_CCY",
  "RS_ACT_LAND_REG_NUM", "RS_ACT_PROP_TYPE", "RS_ACT_OTHER_PROP_TYPE", "RS_ACT_RENTED_DAYS", "RS_ACT_DK_GRI",
  "RS_ACT_DK_GRI_CCY", "RS_ACT_DK_REAL_PROP_REG_NUM", "RS_ACT_DK_VEHICLE_CAT", "RS_ACT_DK_VEHICLE_REG_NUM",
] as const;

type Kolonne = (typeof KOLONNER)[number];
type Raekke = Partial<Record<Kolonne, string>>;

export type Kvartal = { antal: number; vederlagOere: number; gebyrOere: number };

export type Platform = {
  cvr: string;
  navn: string;
  vej: string | null;
  postnummer: string | null;
  bynavn: string | null;
  kontakt: string | null;
};

export type Adresse = { vej: string | null; postnummer: string | null; bynavn: string | null; land: string };

export type EksportSaelger =
  | {
      type: "privat";
      docRefId: string;
      fornavn: string | null;
      efternavn: string | null;
      foedselsdato: string | null; // ÅÅÅÅ-MM-DD
      cpr: string | null; // 10 cifre
      andetTin: { land: string; tin: string } | null;
      adresse: Adresse;
      kvartaler: Kvartal[];
    }
  | {
      type: "erhverv";
      docRefId: string;
      navn: string | null;
      cvr: string | null;
      adresse: Adresse;
      kvartaler: Kvartal[];
    };

export type CsvInput = {
  aar: number;
  // Unik reference for beskeden (fx tidsstempel) - højst 100 tegn.
  beskedRef: string;
  platform: Platform;
  saelgere: EksportSaelger[];
};

// Felter med ; " eller linjeskift sættes i anførselstegn. Linjeskift fjernes.
function felt(v: string | undefined): string {
  if (!v) return "";
  const t = v.replace(/[\r\n]+/g, " ").trim();
  return /[;"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// Skattestyrelsen vil have hele beløb (heltal) - afrundes efter gængse regler.
function heleKroner(oere: number): string {
  return String(Math.round(Number(oere) / 100));
}

// ÅÅÅÅ-MM-DD → DD-MM-ÅÅÅÅ
function dkDato(iso: string | null): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "01-01-1900"; // dummy-værdi (vejledningen afsnit 9)
}

function adresseFelter(a: Adresse, type: string): Raekke {
  const har = !!(a.vej && a.postnummer && a.bynavn);
  return har
    ? {
        ADDR_STREET: a.vej!,
        ADDR_POST_CODE: a.postnummer!,
        ADDR_CITY: a.bynavn!,
        ADDR_COUNTRY: a.land || "DK",
        ADDR_LEGAL_ADDRESS_TYPE: type,
      }
    : { ADDR_FREE: "UKENDT", ADDR_COUNTRY: a.land || "DK", ADDR_LEGAL_ADDRESS_TYPE: "OECD305" };
}

function aktivitet(docRefId: string, kv: Kvartal[]): Raekke {
  const r: Raekke = { ROW_TYPE: "ACT_Sale_Of_Goods", RS_DOC_REF_ID: docRefId };
  for (let i = 0; i < 4; i++) {
    const q = kv[i] ?? { antal: 0, vederlagOere: 0, gebyrOere: 0 };
    const n = (i + 1) as 1 | 2 | 3 | 4;
    r[`RS_ACT_NUM_Q${n}`] = String(q.antal);
    r[`RS_ACT_CONS_Q${n}`] = heleKroner(q.vederlagOere);
    r[`RS_ACT_CONS_Q${n}_CCY`] = "DKK";
    r[`RS_ACT_FEES_Q${n}`] = heleKroner(q.gebyrOere);
    r[`RS_ACT_FEES_Q${n}_CCY`] = "DKK";
    r[`RS_ACT_TAX_Q${n}`] = "0";
    r[`RS_ACT_TAX_Q${n}_CCY`] = "DKK";
  }
  return r;
}

export function byggDac7Csv(input: CsvInput): string {
  const { aar, platform: po } = input;
  const ref = input.beskedRef.replace(/[^A-Za-z0-9]/g, "").slice(0, 100);
  const raekker: Raekke[] = [];

  raekker.push({
    ROW_TYPE: "Message",
    MSG_MESSAGE_REF_ID: `DK${aar}DK${po.cvr}${ref}`,
    MSG_SENDING_ENTITY_IN: po.cvr,
    MSG_CONTACT: po.kontakt ?? undefined,
    MSG_MESSAGE_TYPE_INDIC: input.saelgere.length > 0 ? "DPI401" : "DPI403",
    MSG_REPORTING_PERIOD: `31-12-${aar}`,
    MSG_VERSION: "1.0",
  });

  raekker.push({
    ROW_TYPE: "PO_Platform_Operator",
    PO_DOC_REF_ID: `DK${aar}${po.cvr}PO${ref}`,
    DOC_TYPE_INDIC: "OECD1",
    RESIDENCE: "DK",
    TIN: po.cvr,
    TIN_ISSUED_BY: "DK",
    TIN_UNKNOWN: "FALSK",
    ...adresseFelter({ vej: po.vej, postnummer: po.postnummer, bynavn: po.bynavn, land: "DK" }, "OECD304"),
    ORGANISATION_NAME: po.navn,
    PO_NEXUS: "RPONEX1",
    BUSINESS_NAME: "BidHamr",
  });

  for (const s of input.saelgere) {
    if (s.type === "privat") {
      raekker.push({
        ROW_TYPE: "RS_IND_Individual_Seller",
        RS_DOC_REF_ID: s.docRefId,
        DOC_TYPE_INDIC: "OECD1",
        RESIDENCE: s.adresse.land || "DK",
        TIN: s.cpr ?? undefined,
        TIN_ISSUED_BY: "DK",
        TIN_UNKNOWN: s.cpr ? "FALSK" : "SANDT",
        ...adresseFelter(s.adresse, "OECD302"),
        RS_BIRTH_DATE: dkDato(s.foedselsdato),
        RS_NM_FIRST_NAME: s.fornavn || "UKENDT",
        RS_NM_LAST_NAME: s.efternavn || "UKENDT",
      });
      if (s.andetTin) {
        raekker.push({
          ROW_TYPE: "RS_Tax_Identification_Number",
          RS_DOC_REF_ID: s.docRefId,
          TIN: s.andetTin.tin,
          TIN_ISSUED_BY: s.andetTin.land,
          TIN_UNKNOWN: "FALSK",
        });
      }
    } else {
      raekker.push({
        ROW_TYPE: "RS_ENT_Entity_Seller",
        RS_DOC_REF_ID: s.docRefId,
        DOC_TYPE_INDIC: "OECD1",
        RESIDENCE: "DK",
        TIN: s.cvr ?? undefined,
        TIN_ISSUED_BY: "DK",
        TIN_UNKNOWN: s.cvr ? "FALSK" : "SANDT",
        ...adresseFelter(s.adresse, "OECD303"),
        IN: s.cvr ?? undefined,
        IN_ISSUED_BY: s.cvr ? "DK" : undefined,
        IN_TYPE: s.cvr ? "BRN" : undefined,
        ORGANISATION_NAME: s.navn || "UKENDT",
        RS_PERM_ESTABLISHMENT: "DK",
      });
    }
    raekker.push(aktivitet(s.docRefId, s.kvartaler));
  }

  const linjer = [KOLONNER.join(";"), ...raekker.map((r) => KOLONNER.map((k) => felt(r[k])).join(";"))];
  return "﻿" + linjer.join("\r\n") + "\r\n";
}
