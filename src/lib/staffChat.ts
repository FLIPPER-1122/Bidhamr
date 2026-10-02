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

// Systembrugeren "BidHamr", som staar som messages.sender_id paa
// faellesbeskeder (den rigtige admin staar kun i moderation_log).
// Spejlet i SQL: public.bidhamr_system_id() (20261003001000_staff_chat_rettelser.sql).
export const BIDHAMR_SYSTEM_ID = "00000000-0000-4000-8000-0000000b1d00";

// Faellesbeskeder gemmes med praefiks, saa aeldre app-versioner ogsaa viser
// dem tydeligt. VIGTIGT: UI maa KUN bruge messages.fra_bidhamr til at afgoere,
// om en besked er fra BidHamr - aldrig teksten (en bruger kan ikke skrive
// praefikset, men stol alligevel aldrig paa indholdet). Praefikset fjernes
// derfor kun, naar fraBidhamr er true.
export function fjernFaellesPraefiks(content: string, fraBidhamr: boolean): string {
  if (!fraBidhamr) return content;
  return content.startsWith(FAELLESBESKED_PRAEFIKS)
    ? content.slice(FAELLESBESKED_PRAEFIKS.length)
    : content;
}
