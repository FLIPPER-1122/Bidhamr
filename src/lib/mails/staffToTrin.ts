// Sikkerhedsmails om staffs to-trins-login på admin-hosten (docs/ADMIN-VAERT.md).
// Sendes altid - de handler om sikkerheden på en medarbejderkonto.
import { adminAbsolutUrl } from "@/lib/adminVaert";
import { bygMail, escapeHtml } from "./layout";
import { mailTidspunkt } from "./konto";

const AARSAG =
  "Du får denne mail, fordi du er medarbejder hos BidHamr, og der er sket noget med dit to-trins-login til admin. Sikkerhedsmails kan ikke slås fra.";

const IKKE_DIG =
  "<strong>Var det ikke dig?</strong> Skift din adgangskode med det samme, og skriv til chefen eller support@bidhamr.dk.";

export function toTrinOpsatMail(input: { tidspunkt: Date }) {
  return {
    subject: "To-trins-login er sat op",
    ...bygMail({
      preheader: "Du har sat to-trins-login op til BidHamr admin.",
      overskriftHtml: "To-trins-login er sat op",
      afsnitHtml: [
        "Du har lige sat to-trins-login op til BidHamr admin. Fremover skal du bruge koden fra din app, når du logger ind i admin.",
        "Gem dine gendannelseskoder et sikkert sted. Du skal bruge en af dem, hvis du mister telefonen.",
        IKKE_DIG,
      ],
      info: [{ noegle: "Tidspunkt", vaerdiHtml: escapeHtml(mailTidspunkt(input.tidspunkt)) }],
      knap: { tekst: "Åbn admin", url: adminAbsolutUrl("/admin") },
      aarsag: AARSAG,
    }),
  };
}

export function toTrinNulstilletMail(input: { tidspunkt: Date; aabenTil: Date }) {
  return {
    subject: "Dit to-trins-login er nulstillet",
    ...bygMail({
      preheader: "Chefen har nulstillet dit to-trins-login til BidHamr admin.",
      overskriftHtml: "Dit to-trins-login er nulstillet",
      afsnitHtml: [
        "Chefen har nulstillet dit to-trins-login til BidHamr admin. Den gamle app-kode og dine gendannelseskoder virker ikke længere, og du er logget ud af admin.",
        `Log ind i admin, og sæt en ny app op inden ${escapeHtml(mailTidspunkt(input.aabenTil))}. Appen og bidhamr.dk virker som før.`,
        "<strong>Har du ikke bedt om det?</strong> Skriv til chefen med det samme.",
      ],
      info: [{ noegle: "Tidspunkt", vaerdiHtml: escapeHtml(mailTidspunkt(input.tidspunkt)) }],
      knap: { tekst: "Sæt to-trins-login op", url: adminAbsolutUrl("/adgang/login") },
      aarsag: AARSAG,
    }),
  };
}

export function toTrinTilmeldingMail(input: { aabenTil: Date }) {
  return {
    subject: "Sæt to-trins-login op til admin",
    ...bygMail({
      preheader: "Du kan nu sætte to-trins-login op til BidHamr admin.",
      overskriftHtml: "Sæt to-trins-login op",
      afsnitHtml: [
        "Chefen har åbnet for, at du kan sætte to-trins-login op til BidHamr admin.",
        `Du skal bruge en app som Google Authenticator, Microsoft Authenticator eller 1Password. Log ind, og følg trinene inden ${escapeHtml(mailTidspunkt(input.aabenTil))}.`,
      ],
      knap: { tekst: "Log ind i admin", url: adminAbsolutUrl("/adgang/login") },
      aarsag: AARSAG,
    }),
  };
}

export function toTrinGendannetMail(input: { tidspunkt: Date; tilbage: number }) {
  return {
    subject: "Du har brugt en gendannelseskode",
    ...bygMail({
      preheader: "En gendannelseskode til BidHamr admin er lige blevet brugt.",
      overskriftHtml: "Du har brugt en gendannelseskode",
      afsnitHtml: [
        "En af dine gendannelseskoder til BidHamr admin er lige blevet brugt. Din gamle app-kode virker ikke længere, og du skal sætte en ny app op.",
        `Du har ${input.tilbage} ${input.tilbage === 1 ? "gendannelseskode" : "gendannelseskoder"} tilbage. Når du sætter en ny app op, får du 10 nye.`,
        IKKE_DIG,
      ],
      info: [{ noegle: "Tidspunkt", vaerdiHtml: escapeHtml(mailTidspunkt(input.tidspunkt)) }],
      knap: { tekst: "Sæt en ny app op", url: adminAbsolutUrl("/adgang/opsaet") },
      aarsag: AARSAG,
    }),
  };
}
