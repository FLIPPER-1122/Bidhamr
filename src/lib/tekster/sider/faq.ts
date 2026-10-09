// Tekster til /faq.
// Bygger på ROADMAP-BESLUTNINGER.md. Korte svar – link videre til de lange sider.
//
// OPDATER, når listen over forbudte varer er lavet (ROADMAP fase 3): link til
// den fra svaret under "Forbudte varer".
// OPDATER, når kontaktformularen (/kontakt) er bygget: henvis til den i stedet
// for kun mail.
// OPDATER, når GLS-sporing er bygget: 48-timers fristen starter da ved
// afhentning i pakkeshoppen, ikke ved "Jeg har modtaget pakken".

import type { Tekstside } from "./typer";

export const FAQ_SIDE: Tekstside = {
  titel: "Spørgsmål og svar",
  metabeskrivelse:
    "Svar på de mest stillede spørgsmål om BidHamr: bud, betaling, gebyrer, fragt, afhentning, sager, anke, BidHamr Beskyttelse og din konto.",
  intro:
    "Her finder du korte svar på det, de fleste spørger om. Finder du ikke dit svar, er du velkommen til at skrive til os.",
  afsnit: [],
  faq: [
    {
      id: "bud",
      overskrift: "Bud og auktioner",
      punkter: [
        {
          spoergsmaal: "Er mit bud bindende?",
          svar: "Ja. Et bud kan ikke trækkes tilbage. Har du det højeste bud, når auktionen slutter, har du købt varen og skal betale.",
        },
        {
          spoergsmaal: "Hvor meget skal jeg mindst byde over?",
          svar: "Det afhænger af det højeste bud lige nu. Under 100 kr.: mindst 5 kr. mere. 100-999 kr.: 10 kr. 1.000-4.999 kr.: 50 kr. Fra 5.000 kr.: 100 kr. Det første bud må gerne være lig startprisen.",
        },
        {
          spoergsmaal: "Hvordan virker automatisk bud?",
          svar: "Du skriver det højeste beløb, du vil give – dit maksimum. BidHamr byder så for dig med det mindst mulige, hver gang en anden byder over, indtil dit maksimum er nået. Du betaler altså kun det, der skal til for at føre. Dit maksimum vises aldrig for andre – heller ikke for sælgeren. Andre ser kun de bud, der faktisk bliver afgivet. I budhistorikken står der \"automatisk\" ved de bud, BidHamr har afgivet. Har to bydere et maksimum, fører den højeste – til det laveste beløb, der slår det andet. Er de lige store, fører den, der satte sit maksimum først. Det andet maksimum bliver aldrig vist, heller ikke som et bud. Men det næste bud lægger sig lige over det, så budhistorikken kan godt springe et stykke op. Byder du præcis det samme som en andens maksimum, fører den anden, og du skal byde mere. Du får besked, hvis nogen byder over dit maksimum.",
        },
        {
          spoergsmaal: "Er mit maksimum bindende?",
          svar: "Ja, ligesom et almindeligt bud. Vinder du, skal du betale det, du endte med at byde – højst dit maksimum. Du kan hæve dit maksimum når som helst, mens auktionen kører. Du kan også sænke det, men ikke under dit nuværende bud, hvis du fører.",
        },
        {
          spoergsmaal: "Er der en skjult mindstepris?",
          svar: "Nej. Startprisen er den laveste pris, sælgeren vil sælge for. Der er ingen skjult mindstepris.",
        },
        {
          spoergsmaal: "Hvor længe kører en auktion?",
          svar: "Sælgeren vælger 3, 5, 7 eller 10 dage, når auktionen oprettes.",
        },
        {
          spoergsmaal: "Kan jeg fortryde et køb?",
          svar: "Nej. Du handler med en privatperson, så der er ingen fortrydelsesret.",
        },
      ],
    },
    {
      id: "betaling",
      overskrift: "Betaling og gebyrer",
      punkter: [
        {
          spoergsmaal: "Hvor lang tid har jeg til at betale?",
          svar: "48 timer fra auktionen slutter. Sælgeren kan forlænge fristen til højst 7 dage, hvis I aftaler det. Du får besked, hvis fristen bliver ændret.",
        },
        {
          spoergsmaal: "Hvordan kan jeg betale?",
          svar: "Med kort, MobilePay, Apple Pay, Google Pay eller en anden metode, der vises ved betalingen. Du kan også gemme et kort og slå automatisk betaling til. Det er et tilvalg – du kan sagtens byde uden.",
        },
        {
          spoergsmaal: "Hvad koster det?",
          svar: "Køber og sælger betaler hver 5 % af buddet i gebyr. Fragt betales af køberen og koster fra 40 kr. til en pakkeshop eller fra 60 kr. med levering til døren, alt efter pakkens størrelse. Alle priser er inkl. moms. Du ser altid den samlede pris, før du byder.",
        },
        {
          spoergsmaal: "Holder BidHamr mine penge?",
          svar: "Nej. Betalingen håndteres af vores betalingspartner Stripe. Sælgeren får først pengene, når handlen er gået godt.",
        },
        {
          spoergsmaal: "Hvad sker der, hvis vinderen ikke betaler?",
          svar: "Så annulleres handlen, når fristen er gået. Sælgeren kan tilbyde varen til den næsthøjeste byder eller sætte den op igen gratis. En medarbejder vurderer, om køberen skal have en advarsel.",
        },
        {
          spoergsmaal: "Jeg har fået et tilbud som næsthøjeste byder. Skal jeg sige ja?",
          svar: "Det bestemmer du selv. Tilbuddet er til dit eget højeste bud, og du har 24 timer til at svare. Siger du ja, har du 48 timer til at betale.",
        },
      ],
    },
    {
      id: "fragt",
      overskrift: "Fragt og afhentning",
      punkter: [
        {
          spoergsmaal: "Hvem betaler fragten?",
          svar: "Køberen. Prisen afhænger af pakkens størrelse: til en pakkeshop 40 kr. (Lille, op til 1 kg), 50 kr. (Mellem, op til 5 kg) eller 65 kr. (Stor, op til 15 kg). Levering til døren koster 60 kr. (Lille) eller 85 kr. (Mellem) – store pakker kan kun sendes til en pakkeshop. Fragten står på auktionen, før du byder, og du vælger levering, når du betaler. Varer over 15 kg kan kun afhentes.",
        },
        {
          spoergsmaal: "Hvornår bliver min vare sendt?",
          svar: "Sælgeren skal sende pakken inden 5 dage efter din betaling. Sker det ikke, annulleres handlen automatisk, og du får alle pengene tilbage – også fragt og BidHamr Beskyttelse.",
        },
        {
          spoergsmaal: "Kan jeg vælge at hente varen i stedet?",
          svar: "Kun hvis sælgeren har valgt afhentning på auktionen. Tilbyder auktionen forsendelse, sendes varen.",
        },
        {
          spoergsmaal: "Hvordan foregår en afhentning?",
          svar: "Du har 7 dage fra betalingen til at hente varen. Sælgeren kan forlænge fristen. Når du står med varen og har tjekket den, viser du din afhentningskode. Sælgeren taster den ind og får pengene med det samme. Du kan ikke klage bagefter, så se varen godt efter først.",
        },
        {
          spoergsmaal: "Hvad sker der, hvis varen ikke bliver hentet?",
          svar: "Så får BidHamr besked og ser på handlen. Er der ikke sket noget 14 dage efter betalingen, får køberen automatisk alle pengene tilbage, og sælgeren beholder varen.",
        },
      ],
    },
    {
      id: "beskyttelse",
      overskrift: "Købersikring og BidHamr Beskyttelse",
      punkter: [
        {
          spoergsmaal: "Hvad hjælper BidHamr altid med?",
          svar: "Hvis pakken ikke kommer frem, og ved åbenlys svindel: en tom pakke, en helt anden vare, en falsk kopi solgt som ægte, eller en vare, der aldrig blev sendt.",
        },
        {
          spoergsmaal: "Hvad giver BidHamr Beskyttelse ekstra?",
          svar: "Går varen i stykker under forsendelsen, eller er den ikke som beskrevet, tager BidHamr sagen for dig. Uden BidHamr Beskyttelse må du og sælgeren selv blive enige.",
        },
        {
          spoergsmaal: "Hvad koster BidHamr Beskyttelse?",
          svar: "5 % af dit bud, mindst 25 kr. og højst 250 kr. Du vælger den, når du byder, og valget kan ikke ændres bagefter.",
        },
      ],
    },
    {
      id: "sager",
      overskrift: "Sager og anke",
      punkter: [
        {
          spoergsmaal: "Hvordan opretter jeg en sag?",
          svar: "På handelssiden. Du har 48 timer efter, at du har trykket \"Jeg har modtaget pakken\". Du skal uploade billeder af pakken, labelen og indholdet. Uden billeder kan sagen ikke oprettes.",
        },
        {
          spoergsmaal: "Min pakke er ikke kommet. Hvad gør jeg?",
          svar: "Du kan melde pakken bortkommet 7 dage efter, at sælgeren har sendt den. Vi tjekker sporingen og hjælper dig – også uden BidHamr Beskyttelse.",
        },
        {
          spoergsmaal: "Hvad får jeg tilbage, hvis jeg får medhold?",
          svar: "Prisen for varen, købergebyret og fragten. BidHamr Beskyttelse refunderes ikke, fordi den er brugt på sagen. Skal varen sendes retur, betaler du selv returfragten og får pengene, når pakken er afleveret.",
        },
        {
          spoergsmaal: "Hvornår bliver pengene flyttet efter en afgørelse?",
          svar: "4 dage efter afgørelsen. Det giver tid til en eventuel anke.",
        },
        {
          spoergsmaal: "Kan jeg anke en afgørelse?",
          svar: "Ja, hvis afgørelsen gik imod dig. Knappen til anke åbner 24 timer efter afgørelsen og er åben i 3 dage. Du skal skrive en begrundelse og gerne sende ny dokumentation. Anken behandles af en anden medarbejder, og afgørelsen er endelig. Du kan anke én gang pr. sag.",
        },
      ],
    },
    {
      id: "saelger",
      overskrift: "Når du sælger",
      punkter: [
        {
          spoergsmaal: "Hvad skal jeg bruge for at sælge?",
          svar: "En udbetalingskonto hos vores betalingspartner Stripe. Du kan byde og købe uden, men du skal have den for at oprette en auktion.",
        },
        {
          spoergsmaal: "Hvornår får jeg mine penge?",
          svar: "Når køberen har godkendt varen, eller når køberen ikke har oprettet en sag inden for 48 timer. Ved afhentning får du pengene, så snart du har tastet køberens kode.",
        },
        {
          spoergsmaal: "Kan jeg rette eller annullere min auktion?",
          svar: "Ja, så længe der ikke er bud på den. Når det første bud er kommet, er auktionen låst: du kan ikke ændre noget, tilføje noget eller annullere den. Er der et problem med varen, så kontakt BidHamr.",
        },
        {
          spoergsmaal: "Hvem har ansvaret, hvis varen går i stykker i posten?",
          svar: "Du har ansvaret for at pakke varen forsvarligt. Du tager billeder af indpakningen, når du sender pakken, og de bruges, hvis der kommer en sag.",
        },
      ],
    },
    {
      id: "forbudte-varer",
      overskrift: "Forbudte varer",
      punkter: [
        {
          spoergsmaal: "Er der ting, jeg ikke må sælge?",
          svar: "Ja. Ulovlige varer – fx våben, narkotika, receptpligtig medicin, falske mærkevarer, levende dyr og stjålne ting – kan ikke sættes til salg. Enkelte lovlige varer, fx billetter, alkohol og tobak, bliver kontrolleret af BidHamr. Auktioner, der bryder reglerne, bliver fjernet. Se hele listen under \"Forbudte varer\".",
        },
        {
          spoergsmaal: "Hvordan melder jeg en auktion, der ikke burde være der?",
          svar: "Tryk \"Anmeld opslag\" på auktionen. En medarbejder ser på det.",
        },
      ],
    },
    {
      id: "konto",
      overskrift: "Konto og advarsler",
      punkter: [
        {
          spoergsmaal: "Hvorfor kan jeg få en advarsel?",
          svar: "Fx hvis du vinder en auktion og ikke betaler, eller hvis du som sælger flere gange pakker varer så dårligt, at de går i stykker. En medarbejder giver altid advarslen, og du kan se begrundelsen på din konto.",
        },
        {
          spoergsmaal: "Hvad sker der ved dårlig indpakning?",
          svar: "Første gang får du en påmindelse. Derefter giver hver ny gang en advarsel.",
        },
        {
          spoergsmaal: "Hvad sker der efter 3 advarsler?",
          svar: "Så lukkes din profil permanent. En medarbejder skal altid godkende lukningen – det sker aldrig automatisk.",
        },
        {
          spoergsmaal: "Hvad sker der ved svindel?",
          svar: "Svindler en køber eller sælger, lukkes kontoen permanent.",
        },
      ],
    },
    {
      id: "kontakt",
      overskrift: "Kontakt",
      punkter: [
        {
          spoergsmaal: "Hvordan kontakter jeg BidHamr?",
          svar: "Skriv til support@bidhamr.dk. Er der noget galt med en handel, så opret en sag på handelssiden. Så ligger alt samlet ét sted.",
        },
        {
          spoergsmaal: "Kan jeg chatte med BidHamr?",
          svar: "En medarbejder kan åbne en chat med dig, fx når vi behandler en sag. Beskeder fra BidHamr er tydeligt markeret.",
        },
      ],
    },
  ],
};
