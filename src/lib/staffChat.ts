// Staff-chat: faelles konstanter for server actions og frontend.
// Ingen server-only-import - frontend maa gerne bruge graenser og stier.
// Graenserne er spejlet i supabase/migrations/20261003000000_staff_chat.sql.

export const STAFF_CHAT_MAKS_TEKST = 4000;
export const STAFF_CHAT_MAKS_EMNE = 200;
// messages.content er hoejst 2000 tegn inkl. praefikset "Besked fra BidHamr:".
export const FAELLESBESKED_MAKS_TEKST = 1900;
export const FAELLESBESKED_PRAEFIKS = "Besked fra BidHamr:\n";

// Hvor brugeren ser en samtale med BidHamr (bruges i notifikationer).
export function staffSamtaleSti(samtaleId: string): string {
  return `/beskeder/bidhamr/${samtaleId}`;
}

// Faellesbeskeder gemmes med praefiks, saa aeldre app-versioner ogsaa viser
// dem tydeligt. Frontend, der kender fra_bidhamr, kan fjerne det.
export function fjernFaellesPraefiks(content: string): string {
  return content.startsWith(FAELLESBESKED_PRAEFIKS)
    ? content.slice(FAELLESBESKED_PRAEFIKS.length)
    : content;
}
