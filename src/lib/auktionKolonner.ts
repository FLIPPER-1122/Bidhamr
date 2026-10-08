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
].join(",");

// Rækken, som select(AUKTION_KOLONNER) giver - samme løse type, som
// select("*") gav på den utypede klient.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AuktionRaekke = any;
