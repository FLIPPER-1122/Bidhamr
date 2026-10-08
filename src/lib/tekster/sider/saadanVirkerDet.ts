// Tekster til /saadan-virker-det.
// Bygger på ROADMAP-BESLUTNINGER.md: afsnit 1-4 og 6, "Midlertidige beslutninger",
// "Vinderen betaler ikke" og "Sager".
// Husk: sig aldrig, at BidHamr modtager eller holder pengene – betalingen
// håndteres af vores betalingspartner Stripe.
//
// OPDATER, når GLS-sporing er bygget: i dag starter 48-timers fristen, når
// køberen trykker "Jeg har modtaget pakken". Bagefter starter den, når
// sporingen viser, at pakken er hentet.
// OPDATER, når fragtprisen ikke længere er fast 35 kr.

import type { Tekstside } from "./typer";

export const SAADAN_VIRKER_DET: Tekstside = {
  titel: "Sådan virker det",
  metabeskrivelse:
    "Sådan køber og sælger du på BidHamr: byd, vind, betal inden 48 timer, få varen sendt og godkend handlen. Se gebyrer og BidHamr Beskyttelse.",
  intro:
    "På BidHamr sælger privatpersoner brugte ting til hinanden på auktion. Her kan du se, hvad der sker fra første bud, til sælgeren har fået sine penge.",
  afsnit: [
    {
      id: "koeber",
      overskrift: "Når du køber",
      trin: [
        {
          titel: "Byd på en auktion",
          tekst:
            "Før du byder, ser du den samlede pris med gebyr og fragt. Dit bud er bindende og kan ikke trækkes tilbage. Vil du have BidHamr Beskyttelse, sætter du flueben, når du byder.",
        },
        {
          titel: "Vind auktionen",
          tekst:
            "Har du det højeste bud, når tiden løber ud, har du vundet. Du får besked med det samme.",
        },
        {
          titel: "Betal inden 48 timer",
          tekst:
            "Du betaler med kort, MobilePay, Apple Pay, Google Pay eller en anden metode, der vises ved betalingen. Har du gemt et kort og slået automatisk betaling til, sker det af sig selv. Sælgeren kan give dig mere tid, hvis I aftaler det.",
        },
        {
          titel: "Få varen",
          tekst:
            "Sendes varen, skal sælgeren sende pakken inden 5 dage efter din betaling. Ellers annulleres handlen, og du får alle pengene tilbage. Skal varen hentes, har du 7 dage fra betalingen til at hente den.",
        },
        {
          titel: "Tryk \"Jeg har modtaget pakken\"",
          tekst:
            "Se varen godt efter. Er der noget galt, har du 48 timer til at oprette en sag. Så længe sagen kører, får sælgeren ikke pengene.",
        },
        {
          titel: "Godkend og bedøm sælgeren",
          tekst:
            "Er alt i orden, godkender du handlen og giver sælgeren 1-5 stjerner. Så får sælgeren sine penge. Opretter du ingen sag inden for 48 timer, går pengene automatisk til sælgeren.",
        },
      ],
    },
    {
      id: "saelger",
      overskrift: "Når du sælger",
      trin: [
        {
          titel: "Opret en udbetalingskonto",
          tekst:
            "Før du kan sætte noget til salg, skal du oprette en udbetalingskonto hos vores betalingspartner Stripe. Du må gerne sætte varer til salg, mens Stripe behandler dine oplysninger.",
        },
        {
          titel: "Opret din auktion",
          tekst:
            "Tag gode billeder, skriv en ærlig beskrivelse, og vælg en startpris på mindst 1 kr. Startprisen er også den laveste pris, du sælger for. Du vælger, om auktionen skal køre i 3, 5, 7 eller 10 dage, og om varen sendes eller hentes hos dig.",
        },
        {
          titel: "Vent på bud",
          tekst:
            "Du kan rette eller annullere auktionen, så længe ingen har budt. Når det første bud er kommet, kører auktionen til tiden er gået.",
        },
        {
          titel: "Køberen betaler",
          tekst:
            "Vinderen har 48 timer til at betale. Du kan forlænge fristen til højst 7 dage, hvis I aftaler det. Betaler køberen ikke, kan du tilbyde varen til den næsthøjeste byder eller sætte den op igen gratis.",
        },
        {
          titel: "Send eller udlever varen",
          tekst:
            "Sendes varen, har du 5 dage fra betalingen til at sende pakken. Når du har afleveret den, trykker du \"Send pakken\", tager to billeder af indpakningen og skriver sporingsnummeret. Skal varen hentes, viser køberen en kode, som du taster ind, når du udleverer varen.",
        },
        {
          titel: "Få dine penge",
          tekst:
            "Pengene udbetales, når køberen har godkendt varen, eller når køberen ikke har oprettet en sag inden for 48 timer. Ved afhentning udbetales de, så snart du har tastet koden. Udbetalingen sker via Stripe til din bankkonto.",
        },
      ],
      note: "Nye udbetalingskonter har typisk en ventetid hos Stripe på cirka 7 dage før den første udbetaling.",
      links: [{ tekst: "Sådan pakker du din vare", href: "/pakkeguide" }],
    },
    {
      id: "gebyrer",
      overskrift: "Hvad koster det?",
      tekst: [
        "Det er gratis at oprette en auktion. Vi tager kun et gebyr, når en vare bliver solgt.",
      ],
      punkter: [
        "Køber betaler et gebyr på 5 % af buddet.",
        "Sælger betaler et gebyr på 5 % af buddet. Det trækkes fra, før pengene udbetales.",
        "Fragt koster omkring 35 kr. og betales af køberen. Skal varen hentes, er der ingen fragt.",
        "BidHamr Beskyttelse er et frivilligt tilvalg for køberen: 5 % af buddet, mindst 25 kr. og højst 250 kr.",
        "Alle priser er inkl. moms. Der kommer ikke noget oveni.",
      ],
      note: "Eksempel: Du vinder en vare til 200 kr., som skal sendes. Du betaler 200 kr. + 10 kr. i gebyr + 35 kr. i fragt = 245 kr. Sælgeren får 190 kr.",
    },
    {
      id: "betaling",
      overskrift: "Hvem håndterer betalingen?",
      tekst: [
        "Betalingen håndteres af vores betalingspartner Stripe. Sælgeren får først pengene, når handlen er gået godt: når køberen har godkendt varen, eller når fristen for at oprette en sag er gået.",
        "Opretter køberen en sag, venter udbetalingen, til sagen er afgjort.",
      ],
    },
    {
      id: "beskyttelse",
      overskrift: "BidHamr Beskyttelse",
      tekst: [
        "Du handler med en anden privatperson. Derfor er der ingen fortrydelsesret, og et køb kan ikke fortrydes. Til gengæld kan du som køber vælge BidHamr Beskyttelse, når du byder.",
      ],
      punkter: [
        "Altid, også uden BidHamr Beskyttelse: vi hjælper, hvis pakken ikke kommer frem, og ved åbenlys svindel, fx en tom pakke, en helt anden vare, en falsk kopi solgt som ægte eller en vare, der aldrig blev sendt.",
        "Med BidHamr Beskyttelse: vi tager også sagen, hvis varen er gået i stykker under forsendelsen eller ikke er som beskrevet.",
        "Uden BidHamr Beskyttelse: går varen i stykker undervejs, eller er den ikke som beskrevet, må du og sælgeren selv blive enige.",
        "Den dækker ikke, at du fortryder købet, og den gælder ikke ved afhentning, hvor du ser varen, før du viser koden.",
      ],
      links: [{ tekst: "Læs mere om BidHamr Beskyttelse", href: "/bidhamr-beskyttelse" }],
    },
    {
      id: "sager",
      overskrift: "Hvis noget går galt",
      punkter: [
        "Du opretter en sag på handelssiden inden for 48 timer efter, at du har modtaget pakken. Du skal uploade billeder af pakken, labelen og indholdet.",
        "Er pakken ikke kommet frem, kan du melde det 7 dage efter, at den er sendt.",
        "En medarbejder hos BidHamr ser på sagen og træffer en afgørelse. Pengene flyttes først 4 dage efter afgørelsen.",
        "Er du uenig i afgørelsen, kan du anke én gang. Anken behandles af en anden medarbejder, og afgørelsen på anken er endelig.",
        "Får du medhold og skal sende varen retur, betaler du selv returfragten.",
      ],
      links: [{ tekst: "Spørgsmål og svar", href: "/faq" }],
    },
  ],
};
