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
  mitid_nulstillet: "Nulstillede MitID",
  mitid_forsoeg_behandlet: "Gennemgik MitID-forsøg",
  // 20261015010000_sikkerhed_gennemgang.sql
  mitid_opslag: "Så MitID-oplysninger (juridisk navn og fødselsdato)",
  rapport_behandlet: "Behandlede rapport",
  sag_anke_indgivet: "Anke indgivet",
  sag_anke_stadfaestet: "Stadfæstede afgørelse efter anke",
  sag_anke_omgjort: "Omgjorde afgørelse efter anke",
  chat_laest: "Læste handelschat",
  refusion_proevet_igen: "Prøvede tilbagebetaling igen",
  fragt_haandteret: "Markerede forsendelse som håndteret",
  // 20261016030000_ikke_afhentet_pakke.sql
  handel_ikke_afhentet: "Markerede pakke som ikke afhentet (retur til sælger)",
  // Sikkerhedsnet A (20261019010000).
  noedstop_udbetalinger: "Nødstop: udbetalinger",
  noedstop_betalinger: "Nødstop: nye betalinger",
  udbetaling_godkendt: "Godkendte udbetaling (købers betaling 10.000 kr. eller mere)",
  udbetaling_godkendelse_nulstillet: "Chefens godkendelse af udbetaling nulstillet (ny sag eller anke)",
  bidhamr_daekker: "BidHamr dækker refusionen",
  boost_justering: "Justerede boost-point",
  boost_refunderet: "Refunderede køb af boost-point",
  udbetaling_frosset: "Sælgerens udbetalinger frosset",
  udbetaling_frysning_ophaevet: "Ophævede frysning af sælger",
  spoergsmaal_skjult: "Skjulte spørgsmål på auktion",
  spoergsmaal_vist: "Viste spørgsmål på auktion igen",
  konto_slettet: "Brugeren slettede selv sin konto",
  // 20261007020000_bedoemmelse_svar.sql
  bedoemmelse_skjult: "Skjulte bedømmelse",
  bedoemmelse_vist: "Viste bedømmelse igen",
  bedoemmelse_svar_skjult: "Skjulte sælgers svar på bedømmelse",
  bedoemmelse_svar_vist: "Viste sælgers svar på bedømmelse igen",
  bedoemmelse_beholdt: "Beholdt rapporteret bedømmelse",
  // 20261009010000_dsa.sql
  auktion_skjult: "Skjulte auktion",
  auktion_vist: "Viste auktion igen",
  dsa_anmeldelse_afgjort: "Afgjorde anmeldelse (DSA)",
  dsa_anmeldelse_videresendt: "Videresendte anmeldelse til admin",
  dsa_klage_medhold: "Gav medhold i klage (DSA)",
  dsa_klage_fastholdt: "Fastholdt afgørelse efter klage (DSA)",
  konto_genaabnet: "Genåbnede lukket konto efter klage",
  // 20261010030000_erhverv.sql
  erhverv_henvendelse_opdateret: "Behandlede erhvervshenvendelse",
  erhverv_pakke_gemt: "Gemte erhvervspakke",
  firma_oprettet: "Oprettede firmakonto",
  firma_opdateret: "Ændrede firmakonto",
  firma_velkomst_gensendt: "Sendte velkomstmail til firma igen",
  // 20261017010000_beta_invitationer.sql
  beta_inviteret: "Inviterede til beta-testen",
  beta_genaktiveret: "Genaktiverede beta-invitation",
  beta_sendt_igen: "Sendte beta-invitation igen",
  beta_tilbagekaldt: "Tilbagekaldte beta-invitation",
  beta_aabnet: "Åbnede beta-testen",
  beta_lukket: "Lukkede beta-testen",
  konto_oprettelse_tilladt: "Gav tilladelse til at oprette en konto (fx firmakonto)",
  // 20261029010000_reklamation_fragtfirma.sql (BidHamr anmelder, chefen
  // udbetaler; systemets hændelser logges med systembrugeren som afsender).
  indpakning_ordentlig: "Vurderede indpakningen som ordentlig",
  indpakning_ordentlig_fortrudt: "Fortrød vurderingen \"ordentlig indpakning\"",
  reklamation_oprettet: "Reklamation hos fragtfirma oprettet",
  reklamation_genaabnet: "Reklamation hos fragtfirma aktiv igen",
  reklamation_annulleret: "Annullerede reklamation hos fragtfirma",
  reklamation_sag_aendret: "Sagen ændret efter anmeldt reklamation",
  reklamation_sag_aendret_kvitteret: "Kvitteret for ændret sag (reklamation)",
  reklamation_note: "Skrev intern note på reklamation",
  reklamation_status_rettet: "Rettede status på reklamation",
  reklamation_anmeldt: "Anmeldte skaden hos fragtfirma",
  reklamation_godkendt: "Registrerede: fragtfirmaet godkendte erstatning",
  reklamation_afvist: "Registrerede: fragtfirmaet afviste erstatning",
  reklamation_udbetaling_startet: "Bekræftede modtaget erstatning og startede udbetaling",
  reklamation_udbetaling_fejlet: "Udbetaling af erstatning fejlede",
  reklamation_udbetalt: "Udbetalte erstatning til sælger (Stripe)",
  reklamation_bank_udbetaling: "Erstatning sendt til sælgers bank (Stripe)",
  // Første udgave (sælgeren anmeldte selv) - kun historik på testdatabasen.
  reklamation_gensendt: "Sendte reklamationspakken til sælger igen",
  reklamation_saelger_anmeldt: "Sælger anmeldte skaden hos fragtfirma",
  reklamation_saelger_godkendt: "Sælger: fragtfirmaet godkendte erstatning",
  reklamation_saelger_afvist: "Sælger: fragtfirmaet afviste erstatning",
  reklamation_saelger_fravalgt: "Sælger ønsker ikke at reklamere",
  // 20261101020000_ugens_butik.sql og 20261101060000_ugens_butik_rettelser.sql
  ugens_butik_booket: "Bookede Ugens butik for et firma",
  ugens_butik_annulleret: "Annullerede Ugens butik",
  ugens_butik_refunderet: "Annullerede og refunderede Ugens butik",
  ugens_butik_pris: "Ændrede prisen på Ugens butik",
  ugens_butik_rabat_firma: "Ændrede firmaets rabat på Ugens butik",
  ugens_butik_loft_omgaaet: "Omgik loftet for Ugens butik (4 uger i træk)",
  // 20261029020000_ekstra_fragt.sql (sælgerens indsigelse og betaling logges
  // med systembrugeren som afsender).
  ekstra_fragt_oprettet: "Oprettede ekstraregning for fragt (for lille pakke)",
  ekstra_fragt_frafaldet: "Frafaldt ekstraregning for fragt",
  ekstra_fragt_fastholdt: "Fastholdt ekstraregning for fragt (indsigelse afvist)",
  ekstra_fragt_indsigelse: "Sælger gjorde indsigelse mod ekstraregning for fragt",
  ekstra_fragt_betalt: "Sælger betalte ekstraregning for fragt",
  ekstra_fragt_note: "Skrev intern note på ekstraregning for fragt",
  ekstra_fragt_bankindsigelse_tabt: "Bankindsigelse tabt – betaling af ekstra fragt tilbageført",
  ekstra_fragt_genaabnet: "Genåbnede ekstraregning for fragt efter tabt bankindsigelse",
  ekstra_fragt_bankindsigelse_afsluttet: "Afsluttede tabt bankindsigelse på ekstra fragt uden genåbning",
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
  system: "System",
  dsa: "Anmeldelse/klage (DSA)",
  firma: "Firmakonto",
  erhverv_henvendelse: "Erhvervshenvendelse",
  erhverv_pakke: "Erhvervspakke",
  ugens_butik: "Ugens butik",
  beta_invitation: "Beta-invitation",
  beta: "Beta-testen",
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
      return { href: `/admin/handler/${id}`, label: "Se handel" };
    case "samtale":
      return { href: `/admin/chats/${id}`, label: "Se chat" };
    case "sag":
      return { href: `/admin/sager/${id}`, label: "Se sag" };
    case "dsa":
      return { href: "/admin/dsa?fane=afsluttede", label: "Se anmeldelser" };
    case "beta_invitation":
    case "beta":
      return { href: "/admin/beta", label: "Se beta-invitationer" };
    case "anmeldelse":
      // maal_id er bedømmelsens id (ratings.id) - vis den på Bedømmelser.
      // Meget gamle rækker kan mangle den, så brugerens anmeldelser er reserven.
      if (UUID_RE.test(maalId)) {
        return { href: `/admin/bedommelser?id=${id}`, label: "Se bedømmelse" };
      }
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
