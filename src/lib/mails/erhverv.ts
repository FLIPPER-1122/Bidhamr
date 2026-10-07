// Mails til firmakonti (erhverv). Teksterne kan finpudses af indhold-agenten.
import { bygMail, escapeHtml } from "./layout";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";

// Velkomstmail, når BidHamr har oprettet firmakontoen. linkUrl er et
// engangslink, som logger ind og fører til "Vælg din adgangskode".
export function firmaVelkomstMail(input: { firmanavn: string; linkUrl: string; gensendt?: boolean }) {
  return {
    subject: "Velkommen til BidHamr – vælg din adgangskode",
    ...bygMail({
      preheader: `Jeres firmakonto for ${input.firmanavn} er klar.`,
      overskriftHtml: "Velkommen til BidHamr",
      afsnitHtml: [
        `Vi har oprettet en firmakonto til <strong>${escapeHtml(input.firmanavn)}</strong>.`,
        "Tryk på knappen herunder og vælg en adgangskode. Så er I klar til at sætte varer på auktion.",
        "Linket virker kun én gang og udløber efter et døgn. Er det udløbet, så skriv til os, så sender vi et nyt.",
        `Har I spørgsmål, så skriv til <a href="mailto:${ERHVERV_EMAIL}">${ERHVERV_EMAIL}</a>.`,
      ],
      knap: { tekst: "Vælg adgangskode", url: input.linkUrl },
      aarsag: input.gensendt
        ? "Du får denne mail igen, fordi BidHamr har sendt et nyt link til jeres firmakonto."
        : "Du får denne mail, fordi BidHamr har oprettet en firmakonto til jeres virksomhed.",
    }),
  };
}
