// Danske navne og links til moderation_log (medarbejder-loggen og brugersiden).
//
// HANDLING_NAVNE dækker alle værdier i moderation_log_handling_check (seneste
// definition: supabase/migrations/20261006011000_fragt_rettelser.sql). Kommer der nye
// værdier til, vises den rå værdi, indtil de tilføjes her.
import { BIDHAMR_SYSTEM_ID } from "@/lib/staffChat";

export const HANDLING_NAVNE: Record<string, string> = {
  slet_auktion: "Slettede auktion",
  slet_anmeldelse: "Slettede anmeldelse",
  suspender: "Suspenderede bruger",
  ophaev_suspension: "Ophævede suspension",
  advarsel: "Gav advarsel",
  annuller_auktion: "Annullerede auktion",
  saldo_sat: "Satte saldo (gammel wallet)",
  saldo_tilfoert: "Tilførte saldo (gammel wallet)",
  saldo_traukket: "Trak saldo (gammel wallet)",
  sag_aabnet: "Åbnede sag på handel",
  sag_lukket: "Lukkede sag på handel",
  handel_frigivet: "Frigav handel til sælger",
  handel_refunderet: "Refunderede handel",
  ubetalt_afvist: "Afviste advarsel for ubetalt vinder",
  overfoersel_proevet_igen: "Prøvede udbetaling igen",
  betaling_loest: "Markerede betaling som løst",
  chat_aabnet: "Åbnede chat",
  chat_lukket: "Afsluttede chat",
  faellesbesked: "Sendte fællesbesked",
  sag_afgjort_koeber: "Afgjorde sag til køber",
  sag_afgjort_saelger: "Afgjorde sag til sælger",
  sag_retur_afleveret: "Registrerede retur som afleveret",
  sag_genaabnet: "Genåbnede sag",
  konto_lukket: "Lukkede konto permanent",
  sag_afviklet: "Afviklede sag",
  indpakning_paamindelse: "Gav påmindelse om indpakning",
  konto_lukning_foreslaaet: "Foreslog kontolukning (3 advarsler)",
  konto_lukning_afvist: "Afviste kontolukning",
  udbetalingskonto_loest: "Markerede udbetalingskonto som løst",
  udbetalingskonto_nulstillet: "Nulstillede udbetalingskonto",
  rapport_behandlet: "Behandlede rapport",
  sag_anke_indgivet: "Anke indgivet",
  sag_anke_stadfaestet: "Stadfæstede afgørelse efter anke",
  sag_anke_omgjort: "Omgjorde afgørelse efter anke",
  chat_laest: "Læste handelschat",
  refusion_proevet_igen: "Prøvede tilbagebetaling igen",
  fragt_haandteret: "Markerede forsendelse som håndteret",
  spoergsmaal_skjult: "Skjulte spørgsmål på auktion",
  spoergsmaal_vist: "Viste spørgsmål på auktion igen",
  konto_slettet: "Brugeren slettede selv sin konto",
};

export function handlingNavn(handling: string): string {
  return HANDLING_NAVNE[handling] ?? handling;
}

export function erSystem(id: string | null | undefined): boolean {
  return (id ?? "").toLowerCase() === BIDHAMR_SYSTEM_ID;
}

const MAAL_NAVNE: Record<string, string> = {
  auktion: "Auktion",
  anmeldelse: "Anmeldelse",
  bruger: "Bruger",
  handel: "Handel",
  samtale: "Chat",
  sag: "Sag",
};

// Link til det, handlingen handlede om. null, hvis der ikke findes en side.
export function maalLink(
  maalType: string,
  maalId: string,
  brugerId: string | null,
  // Handlingen i loggen og om den viste medarbejder må åbne /admin/auktioner
  // (kun admin og chef).
  valg: { handling?: string; kanSeAdminAuktioner?: boolean } = {},
): { href: string; label: string } | null {
  const id = encodeURIComponent(maalId);
  switch (maalType) {
    case "auktion":
      // En slettet/annulleret auktion findes ikke offentligt (404) – find den
      // i stedet i admins auktionsoversigt (søgning på id).
      if (valg.handling === "slet_auktion" || valg.handling === "annuller_auktion") {
        return valg.kanSeAdminAuktioner
          ? { href: `/admin/auktioner?q=${id}`, label: "Find auktion" }
          : null;
      }
      return { href: `/auktion/${id}`, label: "Se auktion" };
    case "bruger":
      return erSystem(maalId) ? null : { href: `/admin/brugere/${id}`, label: "Se bruger" };
    case "handel":
      return { href: `/admin/handler?vis=alle&q=${id}`, label: "Se handel" };
    case "samtale":
      return { href: `/admin/chats/${id}`, label: "Se chat" };
    case "sag":
      return { href: `/admin/sager/${id}`, label: "Se sag" };
    case "anmeldelse":
      // Anmeldelser har ingen egen side – vis brugerens anmeldelser.
      return brugerId && !erSystem(brugerId)
        ? { href: `/admin/brugere/${encodeURIComponent(brugerId)}?fane=anmeldelser`, label: "Se anmeldelser" }
        : null;
    default:
      return null;
  }
}

// Staffs læsevisning af chatten mellem køber og sælger på en handel.
export function handelChatSti(tradeId: string): string {
  return `/admin/handler/${encodeURIComponent(tradeId)}/chat`;
}

// faellesbesked() gemmer årsagen som "Besked <message-id>: <tekst>", så
// beskeden kan spores til medarbejderen. Bruges til både at vise teksten uden
// det tekniske præfiks og til at finde afsenderen af en fællesbesked.
const FAELLES_AARSAG_RE =
  /^Besked ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}): /i;

export function faellesbeskedId(aarsag: string | null | undefined): string | null {
  const m = FAELLES_AARSAG_RE.exec(aarsag ?? "");
  return m ? m[1].toLowerCase() : null;
}

// Årsagen som den skal vises: for fællesbeskeder uden "Besked <uuid>: ".
export function visAarsag(handling: string, aarsag: string): string {
  return handling === "faellesbesked" ? aarsag.replace(FAELLES_AARSAG_RE, "") : aarsag;
}

export function maalNavn(maalType: string): string {
  return MAAL_NAVNE[maalType] ?? maalType;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
