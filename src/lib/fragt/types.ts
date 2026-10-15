// Fælles typer for fragt. Handelsflowet kender KUN disse typer - aldrig GLS-
// eller Shipmondo-specifikke felter. Et nyt fragtfirma = en ny adapter, der
// implementerer `Fragtfirma` (se testFirma.ts, gls.ts, shipmondo.ts, dao.ts).
//
// Ingen server-only-import: frontend må gerne bruge typer og navne.

export const FRAGTFIRMAER = ["test", "gls", "shipmondo", "dao"] as const;
export type FragtfirmaNavn = (typeof FRAGTFIRMAER)[number];

// Højst så mange udgående labels pr. handel (også annullerede), før staff skal
// godkende flere. null = ingen fast grænse for sælgeren: DAO direkte kan
// annullere en label (AnnullerePakke), så en label, som DAO har bekræftet
// annulleret, tæller ikke. Databasen (forsendelse_claim) håndhæver reglen -
// her står den kun til visning (FragtlabelBoks).
export function labelGraense(fragtfirma: string | null | undefined): number | null {
  return fragtfirma === "dao" ? null : 2;
}

// Transportøren (det fragtfirma, der kører pakken), når adapteren tilbyder
// flere - Shipmondo: DAO, GLS og PostNord (Filip, 15. okt. 2026). Køberen
// vælger selv i checkout; prisen er den samme for alle tre (låst på
// auktionen pr. pakkestørrelse og leveringsform). Gemmes på handel_levering
// og forsendelser (kolonnen transportoer).
export const TRANSPORTOERER = ["dao", "gls", "postnord"] as const;
export type Transportoer = (typeof TRANSPORTOERER)[number];

export function erTransportoer(v: unknown): v is Transportoer {
  return typeof v === "string" && (TRANSPORTOERER as readonly string[]).includes(v);
}

// Til visning (checkout, "Send pakke", retur). labelfri:
//   "kode"  sælgeren viser/skriver en kode (DAO labelfri)
//   "qr"    sælgeren viser en QR-kode på mobilen (PostNord)
//   null    labelen skal printes (GLS via Shipmondo har ingen labelfri
//           udgående - kun GLS ShopReturn har QR, som bruges til retur)
export type TransportoerInfo = {
  navn: string;
  // Pakkeshoppernes navn i teksterne, fx "daoSHOP".
  shopNavn: string;
  leveringstid: string;
  labelfri: "kode" | "qr" | null;
  returLabelfri: "kode" | "qr" | null;
};

export const TRANSPORTOER_INFO: Record<Transportoer, TransportoerInfo> = {
  dao: { navn: "DAO", shopNavn: "daoSHOP", leveringstid: "1-3 hverdage", labelfri: "kode", returLabelfri: "kode" },
  gls: { navn: "GLS", shopNavn: "GLS-pakkeshop", leveringstid: "1-2 hverdage", labelfri: null, returLabelfri: "qr" },
  postnord: {
    navn: "PostNord",
    shopNavn: "PostNord-pakkeshop",
    leveringstid: "1-2 hverdage",
    labelfri: "qr",
    returLabelfri: "qr",
  },
};

export function transportoerNavn(t: string | null | undefined): string | null {
  return erTransportoer(t) ? TRANSPORTOER_INFO[t].navn : null;
}

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

// Købers valg i checkout: en forsendelse eller afhentning hos sælger (kun når
// auktionen tilbyder både forsendelse og afhentning).
export type CheckoutMaade = Leveringsmaade | "afhentning";

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
  // Kun adaptere med flere transportører (Shipmondo). Mangler den, bruges DAO.
  transportoer?: Transportoer | null;
  // true = shops, hvor man kan AFLEVERE en pakke (retur: køberens nærmeste).
  // Ellers shops, hvor pakken kan hentes (checkout).
  indlevering?: boolean;
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
  // Køberens valgte transportør (Shipmondo). Retur: samme som den udgående.
  transportoer?: Transportoer | null;
};

// Labelen som PDF-bytes eller som URL hos fragtfirmaet (hentes og gemmes i
// BidHamrs private bucket, fordi links hos fragtfirmaet kan udløbe).
export type Label =
  | { type: "pdf"; data: Uint8Array }
  | { type: "url"; url: string };

export type OprettetForsendelse = {
  forsendelsesId: string;
  sporingsnummer: string;
  // null: kun når forsendelsen har en labelfri kode (qrKode), men PDF'en ikke
  // kunne hentes lige nu (DAO). Koden virker uden PDF, og PDF'en hentes, når
  // sælgeren trykker "Hent label" (Fragtfirma.hentLabel).
  label: Label | null;
  // Kode til indlevering uden printer, hvis firmaet har det. Shipmondo/DAO:
  // DAO's labelfri-kode (skrives på pakken / vises i pakkeshoppen).
  qrKode?: string | null;
  // QR-kode som PNG (base64), som sælgeren viser i pakkeshoppen i stedet for
  // en printet label (PostNord, GLS ShopReturn). null = ingen QR.
  qrPng?: string | null;
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
  // Transportøren, fragtfirmaet melder (Shipmondo: carrier_code). Passer den
  // ikke med forsendelsens, gemmes hændelsen ikke (webhook-ruten).
  transportoer?: Transportoer | null;
};

// En hændelseskode, som adapteren ikke kender (fx en ny DAO-kode). Ændrer
// aldrig status - gemmes i fragt_ukendte_koder, og drift får en advarsel.
export type UkendtSporingskode = {
  kode: string;
  liste: string | null;
  beskrivelse: string | null;
  sporingsnummer: string | null;
};

export type SporingsFeed = {
  // Næste token. Gemmes først, når alle hændelser er gemt, så et nedbrud
  // giver en gentagelse og aldrig et hul (hændelser er idempotente).
  nyToken: string;
  haendelser: WebhookHaendelse[];
  ukendte: UkendtSporingskode[];
  // Svaret var større end adapterens lofter: tokenet må IKKE gemmes.
  afkortet?: boolean;
  // Hændelser, der ikke kunne læses (fx uden tidspunkt) - drift alarmeres.
  ugyldige?: number;
};

export type WebhookResultat =
  // ukendte: statuskoder, adapteren ikke kender - ændrer aldrig status, men
  // gemmes i fragt_ukendte_koder (webhook-ruten).
  | { ok: true; haendelser: WebhookHaendelse[]; ukendte?: UkendtSporingskode[] }
  | { ok: false; status: number; fejl: string };

// Svar fra annullerForsendelse. bekraeftet: false = labelen er annulleret hos
// fragtfirmaets mellemmand (Shipmondo), men transportøren har ikke bekræftet
// det (cancelled_at_carrier). Så tæller labelen stadig i labelgrænsen, og en
// returkode giver ikke ret til en ny uden staff. void = bekræftet.
export type AnnulleringSvar = { bekraeftet: boolean };

export interface Fragtfirma {
  navn: FragtfirmaNavn;
  visningsnavn: string;
  // true = adapterens 'returneret' på en udgående pakke, der aldrig er
  // 'leveret', betyder sikkert, at køberen ikke hentede pakken. Så registreres
  // "ikke afhentet" automatisk (src/lib/betaling/ikkeAfhentet.ts): handlen
  // annulleres, og køberen refunderes minus gebyrer og fragt begge veje.
  // Mangler/false (fx Shipmondo, hvor 'returneret' gættes ud fra en tekst):
  // kun markering til staff, der selv trykker "Ikke afhentet" i admin.
  // DAO-adapteren sætter den, når DAO's returkode er kendt.
  returErIkkeAfhentet?: boolean;
  // true = fragtfirmaet kan ikke slå en forsendelse op ud fra BidHamrs
  // reference (DAO). Efter et ukendt udfald laver næste forsøg derfor en NY
  // forsendelse i stedet for at genbruge referencen, og en kendt, forældreløs
  // forsendelse annulleres (se opretForsendelse i server.ts).
  genforsoegOpretterNy?: boolean;
  // Er adapteren sat op (nøgler i env)? Bruges af cron, så et firma uden
  // nøgler ikke kaldes hvert 5. minut. Mangler = antages sat op.
  erSatOp?(): boolean;
  // Transportører, køberen kan vælge imellem (Shipmondo). Mangler = intet valg.
  transportoerer?: readonly Transportoer[];
  // true = fragtfirmaet har sporing (leveret_kl), men intet API til
  // efterlysning: efter 14 dage uden leveringsmelding får staff opgaven at
  // efterlyse manuelt (fragt_efterlysninger, status 'manuel').
  efterlysningUdenApi?: boolean;
  // Pris i øre for en pakke. Postnumre er valgfrie (fast pris i DK).
  beregnPris(
    pakkestoerrelse: Pakkestoerrelse,
    fraPostnummer?: string | null,
    tilPostnummer?: string | null,
  ): Promise<number>;
  opretForsendelse(input: ForsendelseInput): Promise<OprettetForsendelse>;
  annullerForsendelse(forsendelsesId: string): Promise<void | AnnulleringSvar>;
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
  // Valgfri: henter labelen igen (fx når PDF'en manglede ved oprettelsen).
  hentLabel?(forsendelsesId: string): Promise<Label>;
  // Valgfri: alle nye sporingshændelser på ALLE vores pakker siden tokenet
  // (DAO Track & Trace V2). Kaldes højst én gang pr. cron-kørsel.
  hentSporingFeed?(token: string): Promise<SporingsFeed>;
  // Valgfri: efterlysning (bortkommet pakke) hos fragtfirmaet. Kaldes højst
  // én gang pr. forsendelse (fragt_efterlysninger). Kaster FragtFejl, når
  // fragtfirmaet afviser, og FragtUkendtUdfald, når svaret udebliver.
  opretEfterlysning?(sporingsnummer: string, opts: { reference: string; vaerdiOere: number }): Promise<void>;
}

// Vi ved ikke, om fragtfirmaet har oprettet forsendelsen (timeout, netværk,
// 5xx på oprettelsen). Claimet bliver stående, og næste forsøg genbruger
// samme reference - der bestilles aldrig en ny label, før det er afklaret.
//
// foraeldreloesId: fragtfirmaets id på en forsendelse, der BLEV oprettet, men
// som ikke kan bruges (fx fordi svaret ikke kunne gemmes). Bruges af adaptere
// med genforsoegOpretterNy: serveren gemmer id'et og annullerer forsendelsen.
export class FragtUkendtUdfald extends Error {
  readonly foraeldreloesId: string | null;
  constructor(detalje: string, opts: { foraeldreloesId?: string | null } = {}) {
    super(detalje);
    this.name = "FragtUkendtUdfald";
    this.foraeldreloesId = opts.foraeldreloesId ?? null;
  }
}

export const UKENDT_UDFALD_TEKST =
  "Fragtfirmaet svarede ikke i tide. Vent et minut, og prøv igen – du får ikke to labels.";

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
