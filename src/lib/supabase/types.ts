export type AuctionStatus = "aktiv" | "afsluttet" | "annulleret";
export type TransactionStatus =
  | "afventer"
  | "betalt"
  | "frigivet"
  | "refunderet"
  | "annulleret";
export type UserRolle = "bruger" | "medarbejder" | "admin" | "chef";

export interface User {
  id: string;
  navn: string;
  email: string;
  telefon: string | null;
  avatar_url: string | null;
  rating: number;
  rolle: UserRolle;
  suspenderet: boolean;
  suspenderet_aarsag: string | null;
  suspenderet_kl: string | null;
  suspenderet_til: string | null;
  oprettet: string;
}

export interface Auction {
  id: string;
  bruger_id: string;
  titel: string;
  beskrivelse: string | null;
  billeder: string[];
  startpris: number;
  nuværende_bud: number | null;
  lokation: string | null;
  forsendelse_mulig: boolean;
  status: AuctionStatus;
  skjult: boolean;
  slutter_kl: string;
  oprettet: string;
  kategori: string | null;
  postnummer: string | null;
}

export interface Bid {
  id: string;
  auktion_id: string;
  bruger_id: string;
  beløb: number;
  oprettet: string;
}

export interface Transaction {
  id: string;
  auktion_id: string;
  køber_id: string;
  sælger_id: string;
  beløb: number;
  gebyr: number;
  køber_gebyr: number;
  sælger_gebyr: number;
  udbetaling_beløb: number | null;
  udbetalt_kl: string | null;
  status: TransactionStatus;
  oprettet: string;
}

export interface Rating {
  id: string;
  fra_bruger_id: string;
  til_bruger_id: string;
  auktion_id: string;
  stjerner: number;
  kommentar: string | null;
  skjult: boolean;
  oprettet: string;
}

export interface Advarsel {
  id: string;
  bruger_id: string;
  oprettet_af: string | null;
  aarsag: string;
  oprettet_kl: string;
}
