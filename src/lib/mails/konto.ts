// Sikkerheds- og kontomails: nyt login, ændret adgangskode og slettet
// konto. De sendes altid (de kan ikke slås fra under
// notifikationsindstillinger), fordi de handler om kontoens sikkerhed.
import { bygMail, escapeHtml, sideUrl } from "./layout";

const AARSAG_SIKKERHED =
  "Du får denne mail, fordi der er sket noget med sikkerheden på din BidHamr-konto. Sikkerhedsmails kan ikke slås fra.";

export function mailTidspunkt(d: Date) {
  return d.toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const IKKE_DIG = {
  tekst: "Skift din adgangskode",
  url: sideUrl("/glemt-adgangskode"),
};

export function nytLoginMail(input: { tidspunkt: Date; enhed: string }) {
  return {
    subject: "Nyt login på din BidHamr-konto",
    ...bygMail({
      preheader: `Nogen loggede ind på din konto fra ${input.enhed}.`,
      overskriftHtml: "Nyt login på din konto",
      afsnitHtml: [
        "Der er lige blevet logget ind på din BidHamr-konto fra en enhed, vi ikke har set før.",
        "Var det dig, behøver du ikke gøre noget.",
        "<strong>Var det ikke dig?</strong> Skift din adgangskode med det samme, og log ud alle andre steder under Min konto → Sikkerhed.",
      ],
      info: [
        { noegle: "Tidspunkt", vaerdiHtml: escapeHtml(mailTidspunkt(input.tidspunkt)) },
        { noegle: "Enhed", vaerdiHtml: escapeHtml(input.enhed) },
      ],
      knap: IKKE_DIG,
      sekundaer: { tekst: "Se dine enheder", url: sideUrl("/konto#sikkerhed") },
      aarsag: AARSAG_SIKKERHED,
    }),
  };
}

export function adgangskodeAendretMail(input: { tidspunkt: Date }) {
  return {
    subject: "Din adgangskode er ændret",
    ...bygMail({
      preheader: "Adgangskoden til din BidHamr-konto er lige blevet ændret.",
      overskriftHtml: "Din adgangskode er ændret",
      afsnitHtml: [
        "Adgangskoden til din BidHamr-konto er lige blevet ændret, og du er logget ud alle andre steder.",
        "<strong>Var det ikke dig?</strong> Nulstil din adgangskode med det samme, og skriv til support@bidhamr.dk.",
      ],
      info: [{ noegle: "Tidspunkt", vaerdiHtml: escapeHtml(mailTidspunkt(input.tidspunkt)) }],
      knap: { tekst: "Nulstil adgangskode", url: sideUrl("/glemt-adgangskode") },
      aarsag: AARSAG_SIKKERHED,
    }),
  };
}

// Koden til den NYE adresse ved skift af e-mail (src/lib/emailSkift.ts).
export function emailSkiftKodeMail(input: { kode: string; nyEmail: string }) {
  return {
    subject: `${input.kode} er din kode til at skifte e-mail`,
    ...bygMail({
      preheader: "Din kode til at skifte e-mail på BidHamr. Den gælder i 15 minutter.",
      overskriftHtml: "Bekræft din nye e-mail",
      afsnitHtml: [
        "Skriv koden herunder på BidHamr for at bruge denne adresse på din konto. Koden gælder i 15 minutter.",
        "Har du ikke bedt om at skifte e-mail, kan du se bort fra mailen. Så sker der ingenting.",
      ],
      info: [
        { noegle: "Din kode", vaerdiHtml: escapeHtml(input.kode), fremhaev: true },
        { noegle: "Ny e-mail", vaerdiHtml: escapeHtml(input.nyEmail) },
      ],
      aarsag: `Du får denne mail, fordi nogen vil skifte e-mailen på en BidHamr-konto til ${input.nyEmail}. Del aldrig koden med andre – BidHamr spørger dig aldrig om den.`,
    }),
  };
}

// Til den GAMLE adresse, når e-mailen er skiftet.
export function emailAendretMail(input: { tidspunkt: Date; nyEmail: string }) {
  return {
    subject: "Din e-mail er ændret",
    ...bygMail({
      preheader: `Din BidHamr-konto bruger nu ${input.nyEmail}.`,
      overskriftHtml: "Din e-mail er ændret",
      afsnitHtml: [
        `Din e-mail er ændret til <strong>${escapeHtml(input.nyEmail)}</strong>. Fremover logger du ind med den nye adresse, og alle mails fra BidHamr går dertil. Du er logget ud alle andre steder.`,
        "<strong>Var det ikke dig?</strong> Skriv til support@bidhamr.dk med det samme, så hjælper vi dig med at få kontoen tilbage.",
      ],
      info: [
        { noegle: "Tidspunkt", vaerdiHtml: escapeHtml(mailTidspunkt(input.tidspunkt)) },
        { noegle: "Ny e-mail", vaerdiHtml: escapeHtml(input.nyEmail) },
      ],
      knap: { tekst: "Skriv til support", url: "mailto:support@bidhamr.dk?subject=Min%20e-mail%20er%20%C3%A6ndret" },
      aarsag: "Du får denne mail på din tidligere adresse, fordi e-mailen på din BidHamr-konto er ændret. Sikkerhedsmails kan ikke slås fra.",
    }),
  };
}

export function kontoSlettetMail() {
  return {
    subject: "Din konto er slettet",
    ...bygMail({
      preheader: "Din BidHamr-konto er slettet, og dine personlige oplysninger er fjernet.",
      overskriftHtml: "Din konto er slettet",
      afsnitHtml: [
        "Din BidHamr-konto er nu slettet. Dit navn, din e-mail, dit telefonnummer, din adresse, dit profilbillede og dine gemte kort er fjernet, og du kan ikke længere logge ind.",
        "Oplysninger om dine handler og betalinger gemmer vi, fordi bogføringsloven kræver det. De står nu under navnet \"Slettet bruger\" og bruges ikke til andet.",
        "Du er altid velkommen tilbage – du kan oprette en ny konto med samme e-mail, når du vil.",
        "Har du ikke selv slettet din konto, så skriv til support@bidhamr.dk med det samme.",
      ],
      aarsag: "Du får denne mail som kvittering for, at din BidHamr-konto er slettet. Det er den sidste mail, du får fra os.",
    }),
  };
}
