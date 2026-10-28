// Tekster til /saadan-virker-det.
// Bygger på ROADMAP-BESLUTNINGER.md: afsnit 1-4 og 6, "Midlertidige beslutninger",
// "Vinderen betaler ikke" og "Sager".
// Husk: sig aldrig, at BidHamr modtager eller holder pengene – betalingen
// håndteres af vores betalingspartner Stripe.
//
// Fristen for at melde et problem er 72 timer efter levering (Filip, 27. okt.
// 2026). Den starter ved fragtfirmaets leveringsmelding eller "Jeg har
// modtaget pakken".

import type { Tekstside } from "./typer";

export const SAADAN_VIRKER_DET: Tekstside = {
  titel: "Sådan virker det",
  metabeskrivelse:
    "Sådan køber og sælger du på BidHamr: byd, vind, betal inden 48 timer, få varen sendt og godkend handlen. Se gebyrer og BidHamr Beskyttelse.",
  intro:
    "På BidHamr sælger privatpersoner brugte ting til hinanden på auktion. Her kan du se, hvad der sker fra første bud, til sælgeren har fået sine penge.",
  afsnit: [
    {
      id: "mitid",
      overskrift: "Først: bekræft dig med MitID",
      tekst: [
        "Du kan oprette en konto og kigge rundt med det samme. Før du afgiver dit første bud eller opretter din første auktion, bekræfter du dig med MitID. Det tager et minut, og du gør det kun én gang. Firmakonti skal ikke bekræftes med MitID.",
      ],
      punkter: [
        "Tryghed: alle, der byder og sælger, er rigtige personer.",
        "Mindre svindel: hver person kan kun have én konto. Bliver en konto lukket for svindel, kan personen ikke oprette en ny.",
        "Du skal være fyldt 18 år.",
        "Dit navn fra MitID bruger vi kun internt. Andre ser kun dit brugernavn og mærket \"MitID-verificeret\".",
      ],
      links: [{ tekst: "Bekræft dig under Min konto", href: "/konto#mitid" }],
    },
    {
      id: "koeber",
      overskrift: "Når du køber",
      trin: [
        {
          titel: "Byd på en auktion",
          tekst:
            "Før du byder, ser du den samlede pris med gebyr og fragt. Dit bud er bindende og kan ikke trækkes tilbage. Sendes varen, er BidHamr Beskyttelse altid med i gebyret – du skal ikke vælge noget.",
        },
        {
          titel: "Vind auktionen",
          tekst:
            "Har du det højeste bud, når tiden løber ud, har du vundet. Du får besked med det samme.",
        },
        {
          titel: "Betal inden 48 timer",
          tekst:
            "På betalingssiden vælger du levering – en pakkeshop eller levering hjem – og ser den samlede pris. Du betaler selv med kort, Apple Pay, Google Pay og – afhængigt af sælgeren – MobilePay eller Revolut Pay. Vi trækker aldrig penge automatisk. Sælgeren kan give dig mere tid, hvis I aftaler det.",
        },
        {
          titel: "Få varen",
          tekst:
            "Sendes varen, skal sælgeren sende pakken inden 5 dage efter din betaling. Ellers annulleres handlen, og du får alle pengene tilbage. Skal varen hentes, har du 7 dage fra betalingen til at hente den.",
        },
        {
          titel: "Tryk \"Jeg har modtaget pakken\"",
          tekst:
            "Se varen godt efter, og gem pakken og labelen. Er der noget galt, har du 72 timer til at melde et problem. Så længe sagen kører, får sælgeren ikke pengene.",
        },
        {
          titel: "Godkend og bedøm sælgeren",
          tekst:
            "Er alt i orden, godkender du handlen og giver sælgeren 1-5 stjerner. Så får sælgeren sine penge. Melder du ikke et problem inden for 72 timer, går pengene automatisk til sælgeren.",
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
            "Tag gode billeder, skriv en ærlig beskrivelse, og vælg en startpris på mindst 1 kr. Startprisen er også den laveste pris, du sælger for. Du vælger, om auktionen skal køre i 3, 5, 7 eller 10 dage, og om varen sendes eller hentes hos dig. Sendes den, vælger du pakkestørrelse og skriver vægten. Varer over 15 kg kan kun afhentes. Nogle varer må ikke sælges, fx våben, narkotika, levende dyr og kunst (malerier, tegninger, skulpturer og grafiske tryk). Plakater og masseproducerede billeder må gerne sælges.",
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
            "Sendes varen, har du 5 dage fra betalingen til at sende pakken. Du laver fragtlabelen på handelssiden og får en kode, som du viser i en daoSHOP – du behøver ikke en printer. Tag to billeder af indpakningen, og marker pakken som sendt. Skal varen hentes, viser køberen en kode, som du taster ind, når du udleverer varen.",
        },
        {
          titel: "Få dine penge",
          tekst:
            "Pengene bliver frigivet til dig, når køberen har godkendt varen, eller når køberen ikke har meldt et problem inden for 72 timer, efter pakken er leveret. Ved afhentning bliver de frigivet, så snart du har tastet koden. Vores betalingspartner Stripe sender pengene til din bankkonto hver 14. dag. Har du solgt flere ting i den periode, kommer de samlet i én udbetaling.",
        },
      ],
      note: "Nye udbetalingskonter har typisk en ventetid hos Stripe på cirka 7 dage før den første udbetaling.",
      links: [
        { tekst: "Sådan pakker du din vare", href: "/pakkeguide" },
        { tekst: "Forbudte varer", href: "/forbudte-varer" },
      ],
    },
    {
      id: "gebyrer",
      overskrift: "Hvad koster det?",
      tekst: [
        "Det er gratis at oprette en auktion. Vi tager kun et gebyr, når en vare bliver solgt. Gebyret regnes af det bud, varen bliver solgt for.",
      ],
      punkter: [
        "Sælges varen for op til 7.500 kr.: køber betaler 7 % + 5 kr. (højst 300 kr.), og sælger betaler 5 % + 5 kr. (højst 95 kr.).",
        "Sælges varen for mere end 7.500 kr.: køber betaler 300 kr. + 3 % af den del af prisen, der er over 7.500 kr. (højst 650 kr.), og sælger betaler 95 kr. + 2 % af den del, der er over 7.500 kr. (højst 450 kr.). Ved 10.000 kr. betaler køber fx 375 kr., og sælger betaler 145 kr.",
        "Købers gebyr indeholder altid BidHamr Beskyttelse, når varen sendes. Den koster ikke ekstra og skal ikke vælges.",
        "Sælgers gebyr trækkes fra, før pengene udbetales.",
        "Fragt betales af køberen. Til en pakkeshop koster det 42 kr. (Lille, op til 1 kg), 52 kr. (Mellem, op til 5 kg) eller 67 kr. (Stor, op til 15 kg). Levering hjem koster fra 60 kr. Store pakker kan kun sendes til en pakkeshop. Varer over 15 kg kan kun afhentes.",
        "Henter du varen hos sælgeren, er der ingen fragt. Gebyret er det samme.",
        "Det højeste bud og den højeste startpris er 25.000 kr.",
        "Alle priser er inkl. moms. Der kommer ikke noget oveni. Ved auktionen ser du gebyret i kroner og den samlede pris, før du byder.",
        "Både køber og sælger får en faktura fra BidHamr på gebyrerne under Min konto → Fakturaer. Selve varen handles mellem jer, så på den får du en kvittering. Køber du af en erhvervssælger, gælder andre gebyrer, og firmaet sender selv fakturaen på varen.",
      ],
      note: "Eksempel: Du vinder en vare til 200 kr., som skal sendes. Du betaler 200 kr. + 19 kr. i gebyr + 42 kr. i fragt (lille pakke til en pakkeshop) = 261 kr. Sælgeren betaler 15 kr. i gebyr og får 185 kr.",
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
        "Du handler med en anden privatperson. Derfor er der ingen fortrydelsesret, og et køb kan ikke fortrydes. Til gengæld er BidHamr Beskyttelse altid med i købers gebyr, når varen sendes.",
      ],
      punkter: [
        "Altid: vi hjælper, hvis pakken ikke kommer frem, og ved åbenlys svindel, fx en tom pakke, en helt anden vare, en falsk kopi solgt som ægte eller en vare, der aldrig blev sendt.",
        "Når varen sendes: vi tager også sagen, hvis varen er gået i stykker under forsendelsen eller ikke er som beskrevet.",
        "Den dækker ikke, at du fortryder købet, og den gælder ikke ved afhentning, hvor du ser varen, før du viser koden.",
        "Køber du af et firma, gælder BidHamr Beskyttelse ikke. Så har du i stedet fortrydelsesret og reklamationsret efter loven.",
      ],
      links: [{ tekst: "Læs mere om BidHamr Beskyttelse", href: "/bidhamr-beskyttelse" }],
    },
    {
      id: "sager",
      overskrift: "Hvis noget går galt",
      punkter: [
        "Du melder et problem på handelssiden inden for 72 timer efter, at pakken er leveret. Tag et billede af pakken med labelen og et af indholdet.",
        "Er pakken ikke kommet frem, kan du melde det 7 dage efter, at den er sendt.",
        "Sælgeren kan give sin forklaring med tekst og billeder inden for 48 timer. En medarbejder hos BidHamr ser på sagen og træffer en afgørelse. Pengene flyttes først 4 dage efter afgørelsen.",
        "Er du uenig i afgørelsen, kan du anke én gang. Anken behandles af en anden medarbejder, og afgørelsen på anken er endelig.",
        "Er pakken ikke kommet frem, eller er varen gået i stykker under forsendelsen, og får du medhold, får du hele beløbet tilbage og betaler ikke returfragten. I andre sager betaler du selv returfragten, hvis varen skal sendes retur.",
      ],
      links: [{ tekst: "Spørgsmål og svar", href: "/faq" }],
    },
  ],
};
