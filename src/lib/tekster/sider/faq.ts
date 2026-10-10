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
    "Svar på de mest stillede spørgsmål om BidHamr: bud, betaling, gebyrer, fragt, afhentning, sager, anke, BidHamr Beskyttelse, køb fra erhverv og din konto.",
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
          svar: "Ikke når du køber af en privatperson. Så er der ingen fortrydelsesret. Køber du af en erhvervssælger, har du 14 dages fortrydelsesret efter loven.",
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
          svar: "Når du har vundet, går du til betalingssiden. Her vælger du levering, ser den samlede pris og betaler med kort, MobilePay, Apple Pay, Google Pay eller en anden metode, der vises. Du betaler altid selv – vi trækker aldrig penge automatisk, heller ikke hvis du har gemt et kort.",
        },
        {
          spoergsmaal: "Kan jeg gemme mit kort og min adresse?",
          svar: "Ja. Et gemt kort, din adresse og din foretrukne pakkeshop bliver udfyldt på forhånd næste gang, du betaler. Du skal stadig selv trykke \"Betal\".",
        },
        {
          spoergsmaal: "Får jeg en faktura?",
          svar: "Ja, på BidHamrs gebyrer. Som køber får du en faktura på købergebyret, fragten og BidHamr Beskyttelse, hvis du valgte den. Som sælger får du en faktura på sælgergebyret. Alle beløb er inkl. moms. Du finder fakturaerne under Min konto → Fakturaer og på handelssiden.",
        },
        {
          spoergsmaal: "Får jeg en faktura på selve varen?",
          svar: "Nej, ikke når du handler med en privatperson. Så får du en kvittering for handlen. Køber du af en erhvervssælger, sender firmaet selv fakturaen på varen.",
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
          svar: "Køberen. Prisen afhænger af pakkens størrelse: til en pakkeshop 40 kr. (Lille, op til 1 kg), 50 kr. (Mellem, op til 5 kg) eller 65 kr. (Stor, op til 15 kg). Levering hjem koster 60 kr. (Lille) eller 85 kr. (Mellem). Store pakker kan kun sendes til en pakkeshop. Alle priser er inkl. moms. Fragten står på auktionen, før du byder.",
        },
        {
          spoergsmaal: "Hvornår vælger jeg levering?",
          svar: "Når du betaler. På betalingssiden vælger du en pakkeshop fra en liste eller et kort, eller levering hjem, hvis pakken ikke er for stor. Du ser den samlede pris, før du betaler.",
        },
        {
          spoergsmaal: "Hvilket fragtfirma bruger I?",
          svar: "Pakkerne sendes med DAO. Du kan følge pakken på handelssiden.",
        },
        {
          spoergsmaal: "Kan store og tunge ting sendes?",
          svar: "Nej. Varer over 15 kg kan kun afhentes hos sælgeren. Det samme gælder ting, der er for store til en almindelig pakke.",
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
          spoergsmaal: "Hvordan sender jeg pakken?",
          svar: "Når køberen har betalt, laver du fragtlabelen på handelssiden. Du får en kode, som du viser i en daoSHOP, når du afleverer pakken – du behøver ikke en printer. Du kan også hente labelen som PDF. Tag derefter de to pakkebilleder, og marker pakken som sendt på handelssiden.",
        },
        {
          spoergsmaal: "Hvilken pakkestørrelse skal jeg vælge?",
          svar: "Den mindste, varen kan sendes i: Lille (op til 1 kg), Mellem (op til 5 kg) eller Stor (op til 15 kg). Vægten er med kasse og fyld. Vejer varen mere end 15 kg, kan den kun afhentes.",
        },
        {
          spoergsmaal: "Hvem har ansvaret, hvis varen går i stykker i posten?",
          svar: "Du har ansvaret for at pakke varen forsvarligt. Du tager billeder af indpakningen, når du sender pakken, og de bruges, hvis der kommer en sag.",
        },
      ],
    },
    // Erhverv: regler i ROADMAP-BESLUTNINGER.md "Erhvervskonti" og
    // jura/erhvervsvilkaar-udkast.md. "Fortryd køb" og klager over firmaer er
    // besluttet, men ikke bygget endnu (ROADMAP fase 7) – tjek svarene, når de er.
    {
      id: "erhverv",
      overskrift: "Køb fra og salg som erhverv",
      punkter: [
        {
          spoergsmaal: "Hvad betyder \"Erhvervssælger\"?",
          svar: "At sælgeren er et firma med et dansk CVR-nummer, som BidHamr har godkendt. Tryk på mærket for at se firmanavn, CVR-nummer, adresse, telefon og e-mail. Prisen på varen er inkl. moms, og firmaet sender selv fakturaen på varen til dig.",
        },
        {
          spoergsmaal: "Kan jeg fortryde et køb fra et firma?",
          svar: "Ja. Du har 14 dages fortrydelsesret fra den dag, du har fået varen. Tryk \"Fortryd køb\" på handelssiden, så får du en returlabel. Du får pengene tilbage, når firmaet har fået varen retur.",
        },
        {
          spoergsmaal: "Kan jeg vælge BidHamr Beskyttelse, når jeg køber af et firma?",
          svar: "Nej. Når du køber af et firma, har du i stedet fortrydelsesret og reklamationsret efter loven.",
        },
        {
          spoergsmaal: "Varen fra firmaet har en fejl. Hvad gør jeg?",
          svar: "Kontakt firmaet på mail eller telefon. Du har 2 års reklamationsret, så firmaet skal hjælpe dig. Svarer firmaet ikke, eller hjælper det dig ikke, kan du oprette en klage over firmaet på handelssiden. En medarbejder ser på klagen, og får et firma flere berettigede klager, kan det få en advarsel. Du kan også klage til Forbrugerklagenævnet via forbrug.dk.",
        },
        {
          spoergsmaal: "Hvorfor kan jeg ikke skrive til firmaet?",
          svar: "Der er ingen chat med firmaer på BidHamr. Firmaets e-mail og telefon står på firmaets profil og på handelssiden, så du kan kontakte firmaet direkte.",
        },
        {
          spoergsmaal: "Hvordan kan mit firma sælge på BidHamr?",
          svar: "Udfyld formularen på siden Erhverv. Så kontakter vi dig, laver en aftale og opretter firmakontoen for dig. Dit firma skal have et aktivt dansk CVR-nummer og et abonnement. Du kan ikke selv oprette en firmakonto.",
        },
        {
          spoergsmaal: "Hvad skal mit firma sørge for over for køberne?",
          svar: "Køberne har 14 dages fortrydelsesret og 2 års reklamationsret, og dit firma skal tage imod returvarer og behandle reklamationer. Dit firma sender selv fakturaen på varen. Sælger du en ny vare, skal du skrive producent og sikkerhedsoplysninger på auktionen. Dit firmas e-mail og telefon skal være rigtige, så køberne kan kontakte jer.",
        },
        {
          spoergsmaal: "Hvornår får mit firma pengene for et salg?",
          svar: "Når handlen er færdig, og køberens frist for at fortryde er gået. Så sendes pengene til jeres bankkonto. Betalingen håndteres af vores betalingspartner Stripe.",
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
      id: "mitid",
      overskrift: "MitID",
      punkter: [
        {
          spoergsmaal: "Hvorfor skal jeg bruge MitID?",
          svar: "Det gør det trygt at handle med fremmede. Når alle, der byder og sælger, har bekræftet sig med MitID, ved du, at du handler med en rigtig person. Hver person kan kun have én konto, så det er svært at lave falske konti. Bliver en konto lukket for svindel, kan personen ikke oprette en ny. Du skal være fyldt 18 år. Firmakonti skal ikke bekræftes med MitID.",
        },
        {
          spoergsmaal: "Hvornår skal jeg bekræfte mig?",
          svar: "Du kan oprette en konto og kigge rundt uden MitID. Du skal først bekræfte dig, før du afgiver dit første bud eller opretter din første auktion. Det tager et minut, og du gør det kun én gang. Vil du gøre det med det samme, kan du gøre det under Min konto.",
        },
        {
          spoergsmaal: "Kan andre se mit navn fra MitID?",
          svar: "Nej. Andre ser kun dit brugernavn og mærket \"MitID-verificeret\". Dit navn fra MitID bruger vi kun internt. Det vises aldrig for andre brugere og står ikke på fakturaer. Vi får ikke dit CPR-nummer fra MitID.",
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
