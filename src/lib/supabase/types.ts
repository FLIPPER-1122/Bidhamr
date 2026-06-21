export type AuctionStatus = "aktiv" | "afsluttet" | "annulleret";
export type TransactionStatus = "afventer" | "frigivet" | "refunderet";

export interface User {
  id: string;
  navn: string;
  email: string;
  telefon: string | null;
  avatar_url: string | null;
  rating: number;
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
  slutter_kl: string;
  oprettet: string;
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
  oprettet: string;
}
