// Fælles typer for fragt. Handelsflowet kender KUN disse typer - aldrig GLS-
// eller Shipmondo-specifikke felter. Et nyt fragtfirma = en ny adapter, der
// implementerer `Fragtfirma` (se testFirma.ts, gls.ts, shipmondo.ts).
//
// Ingen server-only-import: frontend må gerne bruge typer og navne.

export const FRAGTFIRMAER = ["test", "gls", "shipmondo"] as const;
export type FragtfirmaNavn = (typeof FRAGTFIRMAER)[number];

export const PAKKESTOERRELSER = ["lille", "mellem", "stor"] as const;
export type Pakkestoerrelse = (typeof PAKKESTOERRELSER)[number];

export const PAKKESTOERRELSE_NAVN: Record<Pakkestoerrelse, string> = {
  lille: "Lille",
  mellem: "Mellem",
  stor: "Stor",
};

export function erPakkestoerrelse(v: unknown): v is Pakkestoerrelse {
  return typeof v === "string" && (PAKKESTOERRELSER as readonly string[]).includes(v);
}

// Normaliserede sporingshændelser. Rækkefølgen er den normale vej for en pakke.
//   oprettet            labelen er lavet
//   afleveret           pakken er indleveret i pakkeshop/hos fragtfirmaet
//   i_transit           pakken er undervejs
//   klar_til_afhentning pakken ligger i køberens pakkeshop
//   leveret             køberen har fået/hentet pakken
//   returneret          pakken er på vej retur til afsenderen (fx ikke hentet)
//   fejl                fragtfirmaet melder en fejl (adresse, skadet …)
export const SPORINGS_TYPER = [
  "oprettet",
  "afleveret",
  "i_transit",
  "klar_til_afhentning",
  "leveret",
  "returneret",
  "fejl",
] as const;
export type SporingsType = (typeof SPORINGS_TYPER)[number];

export function erSporingsType(v: unknown): v is SporingsType {
  return typeof v === "string" && (SPORINGS_TYPER as readonly string[]).includes(v);
}

export const SPORINGS_NAVN: Record<SporingsType, string> = {
  oprettet: "Label oprettet",
  afleveret: "Pakken er indleveret",
  i_transit: "Pakken er undervejs",
  klar_til_afhentning: "Klar til afhentning i pakkeshop",
  leveret: "Pakken er leveret",
  returneret: "Pakken er sendt retur",
  fejl: "Fejl hos fragtfirmaet",
};

export type Adresse = {
  navn: string;
  adresse?: string | null;
  postnummer?: string | null;
  by?: string | null;
  land?: "DK";
  email?: string | null;
  telefon?: string | null;
};

// Købers leveringsvalg i checkout (før betalingen).
export const LEVERINGSMAADER = ["pakkeshop", "doer"] as const;
export type Leveringsmaade = (typeof LEVERINGSMAADER)[number];

export const LEVERINGSMAADE_NAVN: Record<Leveringsmaade, string> = {
  pakkeshop: "Afhentning i pakkeshop",
  doer: "Levering til døren",
};

export function erLeveringsmaade(v: unknown): v is Leveringsmaade {
  return typeof v === "string" && (LEVERINGSMAADER as readonly string[]).includes(v);
}

// En pakkeshop fra fragtfirmaet (normaliseret).
export type Pakkeshop = {
  id: string;
  navn: string;
  adresse: string;
  postnummer: string;
  by: string;
  lat: number | null;
  lng: number | null;
  // Afstand i meter fra den søgte adresse (eller postnummerets midte).
  afstandM: number | null;
  // Fx [{ dag: "Mandag", tider: "09:00 - 19:00" }]. Tom, hvis ukendt.
  aabningstider: { dag: string; tider: string }[];
};

export type PakkeshopSoegning = {
  postnummer: string;
  by?: string | null;
  adresse?: string | null;
  antal?: number;
};

export type ForsendelseInput = {
  // BidHamrs forsendelses-id. Sendes som reference/idempotensnøgle til
  // fragtfirmaet, så et genforsøg ikke bestiller to labels.
  reference: string;
  handel: { id: string; titel: string };
  afsender: Adresse;
  modtager: Adresse;
  pakkestoerrelse: Pakkestoerrelse;
  // Pakkeshop eller levering til døren (udgående). Retur: altid til en
  // pakkeshop tæt på modtageren (fragtfirmaet vælger den nærmeste).
  levering?: Leveringsmaade;
  // Køberens valgte pakkeshop (levering = pakkeshop).
  pakkeshopId?: string | null;
  // Vægt på labelen i gram (sælgerens vægt eller pakkestørrelsens maksimum).
  vaegtGram?: number | null;
};

// Labelen som PDF-bytes eller som URL hos fragtfirmaet (hentes og gemmes i
// BidHamrs private bucket, fordi links hos fragtfirmaet kan udløbe).
export type Label =
  | { type: "pdf"; data: Uint8Array }
  | { type: "url"; url: string };

export type OprettetForsendelse = {
  forsendelsesId: string;
  sporingsnummer: string;
  label: Label;
  // Kode til indlevering uden printer, hvis firmaet har det. Shipmondo/DAO:
  // DAO's labelfri-kode (skrives på pakken / vises i pakkeshoppen).
  qrKode?: string | null;
  // Fragtfirmaets pris til BidHamr i øre (omkostning - ikke købers fragt).
  // Shipmondo: prisen inkl. moms fra svaret.
  prisOere?: number | null;
  // Fragtfirmaets produktkode (fx DAO_STS).
  produkt?: string | null;
};

export type Sporingshaendelse = {
  type: SporingsType;
  // ISO-tidspunkt fra fragtfirmaet.
  tidspunkt: string;
  // Stabil nøgle for hændelsen (fragtfirmaets hændelses-id eller type +
  // tidspunkt). Samme hændelse via webhook og sporing SKAL give samme nøgle.
  noegle: string;
  beskrivelse?: string | null;
  // Lille udsnit af fragtfirmaets data (højst 4 KB gemmes).
  raa?: Record<string, unknown> | null;
};

export type WebhookHaendelse = Sporingshaendelse & {
  sporingsnummer?: string | null;
  forsendelsesId?: string | null;
};

export type WebhookResultat =
  | { ok: true; haendelser: WebhookHaendelse[] }
  | { ok: false; status: number; fejl: string };

export interface Fragtfirma {
  navn: FragtfirmaNavn;
  visningsnavn: string;
  // Pris i øre for en pakke. Postnumre er valgfrie (fast pris i DK).
  beregnPris(
    pakkestoerrelse: Pakkestoerrelse,
    fraPostnummer?: string | null,
    tilPostnummer?: string | null,
  ): Promise<number>;
  opretForsendelse(input: ForsendelseInput): Promise<OprettetForsendelse>;
  annullerForsendelse(forsendelsesId: string): Promise<void>;
  hentSporing(sporingsnummer: string): Promise<Sporingshaendelse[]>;
  // Returlabel i sager: afsender = køberen, modtager = sælgeren.
  opretReturforsendelse(input: ForsendelseInput): Promise<OprettetForsendelse>;
  // Verificerer signaturen og oversætter fragtfirmaets webhook til
  // normaliserede hændelser. Læser selv body'en (kun én gang).
  fortolkWebhook(request: Request): Promise<WebhookResultat>;
  // Pakkeshops nær en adresse/et postnummer (nærmeste først).
  soegPakkeshops(q: PakkeshopSoegning): Promise<Pakkeshop[]>;
  // Slår én pakkeshop op (validering af købers valg). null = findes ikke.
  hentPakkeshop(id: string, naer: PakkeshopSoegning): Promise<Pakkeshop | null>;
}

// Fragtfirmaet kan ikke annullere forsendelsen (fx DAO via Shipmondo). BidHamr
// annullerer labelen hos sig selv, og staff får besked, så de kan bede
// fragtfirmaet om at kreditere den.
export class FragtAnnulleringIkkeMulig extends Error {
  constructor(detalje?: string) {
    super(detalje ?? "Fragtfirmaet kan ikke annullere forsendelsen.");
    this.name = "FragtAnnulleringIkkeMulig";
  }
}

// Fejl med en tekst, der må vises til brugeren. Andre fejl vises som
// "Noget gik galt".
export class FragtFejl extends Error {
  readonly brugerbesked: string;
  constructor(brugerbesked: string, detalje?: string) {
    super(detalje ?? brugerbesked);
    this.name = "FragtFejl";
    this.brugerbesked = brugerbesked;
  }
}

export const FRAGT_IKKE_SAT_OP = "Fragt er ikke sat op endnu.";
