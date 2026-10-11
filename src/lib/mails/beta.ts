// Mails til beta-testen (docs/BETA-TEST.md) og koden ved oprettelse af en
// konto. Sendes via Resend (sendHandelMailDetaljer) - ikke via Supabase -
// fordi kontoen oprettes på serveren med generateLink, som ingen mail sender
// (src/lib/kontoOprettelse.ts).
import { bygMail, escapeHtml, sideUrl } from "./layout";

export const BETA_MAIL = {
  invitation: {
    emne: "Du er inviteret til at teste BidHamr",
    forhaandsvisning: "Opret din konto og vær med i beta-testen af BidHamr.",
    overskrift: "Du er inviteret til beta-testen",
    tekst: [
      "Tak, fordi du vil hjælpe os med at teste BidHamr, før siden åbner for alle.",
      "Under testen køber og sælger du med testpenge. Ingen rigtige penge bevæger sig, og der sendes ingen rigtige pakker.",
      "Brug aldrig dit rigtige betalingskort, dit rigtige MitID eller dit CPR-nummer under testen. Du får testoplysningerne i vejledningen.",
    ],
    nyKonto: "Opret din konto med netop denne e-mail. Andre e-mails kan ikke oprette en konto endnu.",
    harKonto: "Du har allerede en konto med denne e-mail. Log ind, så har du adgang til hele siden under testen.",
    knapOpret: "Opret din konto",
    knapLogInd: "Log ind",
    fodnote: (email: string) =>
      `Du får denne mail, fordi BidHamr har inviteret ${email} til beta-testen. Har du ikke bedt om det, kan du se bort fra mailen.`,
  },
  kode: {
    emne: "Din kode til BidHamr",
    forhaandsvisning: (kode: string) => `Din kode er ${kode}. Indtast den på bidhamr.dk for at bekræfte din e-mail.`,
    overskrift: "Bekræft din e-mail",
    tekst: [
      "Indtast koden på bidhamr.dk for at bekræfte din e-mail og gøre din konto klar. Koden udløber om 1 time.",
      "Har du ikke oprettet en konto, kan du se bort fra mailen.",
    ],
    noegle: "Din kode",
    fodnote: (email: string) =>
      `Du får denne mail, fordi nogen har oprettet en konto på bidhamr.dk med ${email}. Del aldrig koden med andre - BidHamr spørger dig aldrig om den.`,
  },
} as const;

// Invitationen. harKonto: e-mailen har allerede en konto (så skal personen
// bare logge ind).
export function betaInvitationMail(input: { email: string; harKonto: boolean }) {
  const T = BETA_MAIL.invitation;
  return {
    subject: T.emne,
    ...bygMail({
      preheader: T.forhaandsvisning,
      overskriftHtml: escapeHtml(T.overskrift),
      afsnitHtml: [...T.tekst, input.harKonto ? T.harKonto : T.nyKonto].map((t) => escapeHtml(t)),
      info: [{ noegle: "Din e-mail", vaerdiHtml: escapeHtml(input.email) }],
      knap: input.harKonto
        ? { tekst: T.knapLogInd, url: sideUrl("/login") }
        : { tekst: T.knapOpret, url: sideUrl("/signup") },
      aarsag: T.fodnote(input.email),
    }),
  };
}

// Bekræftelseskoden ved oprettelse - åben og lukket tilmelding (samme indhold som
// supabase/templates/confirmation.html). Koden kommer fra
// auth.admin.generateLink({ type: "signup" }) og indtastes på /tjek-indbakke.
export function betaKodeMail(input: { email: string; kode: string }) {
  const T = BETA_MAIL.kode;
  return {
    subject: T.emne,
    ...bygMail({
      preheader: T.forhaandsvisning(input.kode),
      overskriftHtml: escapeHtml(T.overskrift),
      afsnitHtml: T.tekst.map((t) => escapeHtml(t)),
      info: [{ noegle: T.noegle, vaerdiHtml: escapeHtml(input.kode), fremhaev: true }],
      aarsag: T.fodnote(input.email),
    }),
  };
}
