// Kolonner på auctions, som brugere (anon/authenticated) må læse.
// vinder_id er IKKE med: den kan kun læses med service role på serveren
// (20261010061000_niels_m03_vinder_id_app_afhaengig.sql). Derfor virker
// select("*") på auctions ikke fra brugerens klient - brug denne liste.
// Ny kolonne på auctions? Tilføj den her OG grant select (kolonne) i
// migrationen.
// Kun kolonner, der findes i BÅDE produktion og testdatabasen (prod har
// også app-kolonnerne vis_antal_bud og is_bundle, test har visninger).
// Typet som string (ikke en literal), fordi supabase-js ikke kan parse
// "nuværende_bud" i en select-streng.
export const AUKTION_KOLONNER: string = [
  "id",
  "bruger_id",
  "titel",
  "beskrivelse",
  "billeder",
  "startpris",
  "nuværende_bud",
  "lokation",
  "forsendelse_mulig",
  "status",
  "slutter_kl",
  "oprettet",
  "kategori",
  "postnummer",
  "lat",
  "lng",
  "skjult",
  "stand",
  "maerke",
  "antal_bud",
  "afsluttet_kl",
  "arkiveret_kl",
  "varighed_dage",
  "redigeret_kl",
  "spoergsmaal_aktiv",
  "forbudt_bekraeftet",
  "idempotens_noegle",
  "visningspris",
  "pauset_kl",
  "pause_resterende",
  "erhverv",
  "producent",
  "sikkerhedsoplysninger",
  // Fragt (20261012010000): pakkestørrelse, vægt og den låste fragtpris.
  "pakkestoerrelse",
  "vaegt_gram",
  "fragt_pakkeshop_oere",
  "fragt_doer_oere",
  // Afhentning som valg (20261012090000): også afhentning ved forsendelse.
  "afhentning_mulig",
].join(",");

// Rækken, som select(AUKTION_KOLONNER) giver. Holdes i trit med listen
// ovenfor (numeric kommer som tal fra PostgREST, interval som tekst).
export type AuktionRaekke = {
  id: string;
  bruger_id: string;
  titel: string;
  beskrivelse: string | null;
  billeder: string[];
  startpris: number;
  nuværende_bud: number | null;
  lokation: string | null;
  forsendelse_mulig: boolean;
  status: string;
  slutter_kl: string;
  oprettet: string;
  kategori: string | null;
  postnummer: string | null;
  lat: number | null;
  lng: number | null;
  skjult: boolean;
  stand: string | null;
  maerke: string | null;
  antal_bud: number;
  afsluttet_kl: string | null;
  arkiveret_kl: string | null;
  varighed_dage: number | null;
  redigeret_kl: string;
  spoergsmaal_aktiv: boolean;
  forbudt_bekraeftet: boolean;
  idempotens_noegle: string | null;
  visningspris: number | null;
  pauset_kl: string | null;
  pause_resterende: string | null;
  erhverv: boolean;
  producent: string | null;
  sikkerhedsoplysninger: string | null;
  pakkestoerrelse: string | null;
  vaegt_gram: number | null;
  fragt_pakkeshop_oere: number | null;
  fragt_doer_oere: number | null;
  afhentning_mulig: boolean;
};
