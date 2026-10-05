// Tekster til /om.
// Ingen tal, priser eller løfter, der ikke står i ROADMAP-BESLUTNINGER.md.
// Ejerens navn står ikke her: CLAUDE.md nævner ejeren, men der står ikke, at
// navnet må vises offentligt. Filip skal sige ja, før det tilføjes.
// OPDATER, når MitID er på plads (ROADMAP-BESLUTNINGER afsnit 7): tilføj et
// punkt om MitID-verificerede brugere. Det må ikke stå her før.
// OPDATER, når CVR-nummer og adresse er på plads: tilføj dem under "Kontakt".

import type { Tekstside } from "./typer";

export const OM: Tekstside = {
  titel: "Om BidHamr",
  metabeskrivelse:
    "BidHamr er en dansk auktionsplatform, hvor privatpersoner sælger brugte ting til hinanden – trygt og enkelt.",
  intro:
    "BidHamr er en dansk auktionsplatform, hvor privatpersoner sælger brugte ting til hinanden. Vi vil gøre det nemt at give dine ting et nyt hjem og trygt at købe af en, du ikke kender.",
  afsnit: [
    {
      id: "hvad",
      overskrift: "Hvad er BidHamr?",
      tekst: [
        "På BidHamr sætter du dine ting til salg på en auktion, der kører i et bestemt antal dage. Køberne byder, og den, der har det højeste bud, når tiden er gået, køber varen.",
        "Alle, der handler, er privatpersoner. BidHamr er stedet, hvor I mødes, og vi hjælper, når noget går galt.",
      ],
    },
    {
      id: "tryghed",
      overskrift: "Tryghed",
      punkter: [
        "Betalingen håndteres af vores betalingspartner Stripe. Sælgeren får først pengene, når handlen er gået godt.",
        "Vi hjælper altid, hvis en pakke ikke kommer frem, og ved åbenlys svindel.",
        "Med BidHamr Beskyttelse kan køberen også få hjælp, hvis varen går i stykker under forsendelsen eller ikke er som beskrevet.",
        "Du ser altid den samlede pris med gebyr og fragt, før du byder.",
        // OPDATER: når ROADMAP-punktet om sælgerens adresse/telefon er færdigt
        // og testet, kan dette tilføjes: "Sælgerens adresse og telefonnummer
        // vises aldrig offentligt."
      ],
      links: [
        { tekst: "Sådan virker det", href: "/saadan-virker-det" },
        { tekst: "BidHamr Beskyttelse", href: "/bidhamr-beskyttelse" },
      ],
    },
    {
      id: "open-source",
      overskrift: "Open source",
      tekst: [
        "Når du uploader billeder i HEIC-format (fx fra en iPhone), omdanner hjemmesiden dem til JPEG i din browser med heic-to, som bygger på libheif. Begge er open source under licensen LGPL-3.0, og kildekoden kan hentes frit.",
        // Kreditering kræves af CC BY 4.0 (src/data/postnumre.ts).
        "Postnumre, bynavne og koordinater til afstandsfilteret kommer fra GeoNames (geonames.org) og bruges under licensen CC BY 4.0.",
      ],
      links: [
        { tekst: "Kildekoden til heic-to", href: "https://github.com/hoppergee/heic-to" },
        { tekst: "Kildekoden til libheif", href: "https://github.com/strukturag/libheif" },
        { tekst: "GeoNames", href: "https://www.geonames.org" },
        { tekst: "Licensen CC BY 4.0", href: "https://creativecommons.org/licenses/by/4.0/deed.da" },
      ],
    },
    {
      id: "kontakt",
      overskrift: "Kontakt",
      tekst: ["Har du spørgsmål eller forslag, så skriv til support@bidhamr.dk."],
      links: [{ tekst: "Spørgsmål og svar", href: "/faq" }],
    },
  ],
};
