// Velkomstmail til ventelisten (coming-soon). Bruges af /api/waitlist.
import { bygMail, sideUrl } from "./layout";

export function velkomstMail(email: string) {
  return {
    subject: "Du er på ventelisten til BidHamr",
    ...bygMail({
      preheader: "Tak for din tilmelding. Vi giver dig besked, når BidHamr åbner.",
      overskriftHtml: "Tak for din tilmelding",
      afsnitHtml: [
        "Du er nu på ventelisten til BidHamr – stedet, hvor private køber og sælger brugte ting på auktion.",
        "Vi giver dig besked, når vi åbner, så du kan være med fra første dag. Indtil da hører du kun fra os, hvis der er nyt.",
        "Vi glæder os til at se dig.",
      ],
      sekundaer: { tekst: "Besøg bidhamr.dk", url: sideUrl("/") },
      aarsag: `Du får denne mail, fordi ${email} er skrevet op til ventelisten på bidhamr.dk. Har du ikke selv skrevet dig op, kan du se bort fra mailen.`,
    }),
  };
}

