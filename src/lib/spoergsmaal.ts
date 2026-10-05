// "Spørg sælger" – grænser og typer. Samme grænser i databasen
// (stil_spoergsmaal / besvar_spoergsmaal i
// supabase/migrations/20261006020000_auktionsfunktioner.sql).
export const MAKS_SPOERGSMAAL = 500;
export const MIN_SPOERGSMAAL = 3;
export const MAKS_SVAR = 1000;

export const SPOERGSMAAL_SLAAET_FRA =
  "Sælgeren modtager ikke spørgsmål – læs beskrivelsen grundigt.";

// En række fra public.auktion_spoergsmaal_liste (ingen bruger-id'er).
export type SpoergsmaalVisning = {
  id: string;
  question: string;
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
  asker_name: string;
  is_mine: boolean;
  hidden: boolean;
};
