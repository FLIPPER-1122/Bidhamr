// Velkomstmail til ventelisten (coming-soon). Bruges af /api/waitlist.
import { bygMail, sideUrl } from "./layout";

export function velkomstMail(email: string) {
  return {
    subject: "Velkommen til BidHamr ventelisten 🎉",
    ...bygMail({
      preheader: "Du er på ventelisten. Vi giver besked, så snart vi lancerer.",
      overskriftHtml: "Tak for din tilmelding!",
      afsnitHtml: [
        "Du er nu på ventelisten til BidHamr — Danmarks nye lokale auktionsplatform.",
        "Vi giver dig besked, så snart vi lancerer, så du kan være med fra dag ét. Du hører først fra os igen, når der er nyt — vi sender ikke spam.",
        "Vi glæder os til at have dig med.",
      ],
      sekundaer: { tekst: "Besøg bidhamr.dk", url: sideUrl("/") },
      aarsag: `Du modtager denne mail, fordi ${email} blev tilmeldt ventelisten på bidhamr.dk. Har du ikke selv tilmeldt dig, kan du roligt ignorere denne mail.`,
    }),
  };
}

