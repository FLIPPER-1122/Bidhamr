# BidHamr – produktretning

Arbejdsdokument. Skal kunne læses alene og give retningen uden at læse hele roadmappen.
Forretningsreglerne står i `ROADMAP-BESLUTNINGER.md`. Er der tvivl, gælder beslutningerne – ikke dette dokument.

## Hvad BidHamr er

BidHamr er en dansk auktionsplatform for privatpersoner. Folk sælger brugte ting til hinanden på auktioner med en fast sluttid. Højeste bud, når tiden løber ud, vinder.

- Kun privatpersoner. Ikke butikker, ikke erhverv.
- Kun auktioner. Alt sælges ved, at folk byder.
- Appen er det primære produkt. De fleste brugere skal bruge appen.
- Hjemmesiden matcher appen 1:1: samme funktioner, samme tekster, samme design, samme database og samme betalingsflow.

## Den korte formel

**Tradera for auktionen, Vinted for handlen, egne regler.**

**Fra Tradera – selve auktionen.** Auktionen er hjertet i produktet: synlig startpris, som også er mindsteprisen, minimum budstigning, valgfri varighed, autobud hvor du sætter dit maksimum og systemet byder op for dig, og bindende bud, der ikke kan trækkes tilbage. Kategorier med ikoner og "Slutter snart" på forsiden.

**Fra Vinted – handlen efter auktionen.** Alt det praktiske ligger inde i platformen, så to fremmede ikke skal aftale noget selv. Betalingen sker gennem BidHamr. Sælgeren får sin fragtlabel i BidHamr. Køberen kan følge pakken. Pengene holdes tilbage, indtil køberen har fået varen og godkendt den. Går noget galt, oprettes en sag i platformen. Sender sælgeren ikke inden 5 dage, annulleres handlen, og køberen får sine penge tilbage.

**Egne regler – det, der er BidHamrs eget.**
- Uret starter, når sporingen viser, at køberen har hentet pakken. Derfra har han 48 timer til at oprette en sag. Sker der intet, frigives pengene til sælgeren.
- Afhentning udløser aldrig udbetaling i sig selv. Pengene går først videre, når køberen bekræfter, eller de 48 timer er gået.
- BidHamr Beskyttelse er et frivilligt tilkøb, ikke noget alle betaler for.
- Uden BidHamr Beskyttelse hjælper BidHamr ikke med retur. Med beskyttelse håndterer BidHamr sagen for køberen.
- Åbenlys svindel giver altid en sag, uanset om køberen har tilkøbt beskyttelse.
- Sælgeren skal fotografere indpakningen i appen, før pakken sendes. Dårlig indpakning giver først en påmindelse, derefter advarsler. Tre advarsler lukker profilen permanent.
- Kun køberen bedømmer sælgeren, og kun i forbindelse med at handlen godkendes.
- Den, der taber en sag, kan anke. Knappen åbner 24 timer efter afgørelsen, og derefter er der 3 dage. Afgørelsen på en anke er endelig.
- Afhentning hos sælgeren er en mulighed. Køberen viser en kode, pengene frigives med det samme, og der er ingen klagefrist bagefter.

## Hvem produktet er til

Almindelige danskere, der har ting liggende, de ikke bruger, og gerne vil sælge dem uden at skulle mødes med fremmede eller forhandle over beskeder. Og købere, der vil gøre en god handel på brugte ting uden at være nervøse for at sende penge til en, de ikke kender.

Den svære bruger er den nye sælger. Han skal turde lægge sin ting op hos en platform, han ikke kender. Derfor er tryghed en del af selve produktet, ikke noget vi skriver i markedsføringen:

- Alle profiler er MitID-verificerede. Det gør det svært at oprette en ny profil, hvis man er blevet lukket ned.
- Pengene er trukket, før sælgeren sender. Sælgeren pakker aldrig en vare til en køber, der ikke kan betale.
- Fragtlabel og sporing kommer gennem BidHamr, så begge parter kan se, hvor pakken er.
- Køberen kan ikke fortryde. Sælgeren risikerer ikke at få varen tilbage, fordi køberen fik fortrudt.
- Sælgerens adresse og telefonnummer vises aldrig offentligt. Kun det, køberen har brug for, deles efter handlen.
- Står ord mod ord, og sporingen viser levering, får sælgeren pengene.
- Svindel lukker kontoen permanent, uanset om det er køberen eller sælgeren.

## Pengemodellen kort

- **Stripe holder pengene.** BidHamr har ingen saldo og intet wallet. Findes der tekst eller kode med en BidHamr-saldo, er det den gamle model, som er droppet.
- Køberen **gemmer et betalingskort** ved oprettelse af profil. Der trækkes intet. Man kan ikke byde uden et gemt kort.
- Når auktionen slutter, **trækkes vinderens kort automatisk**: bud + købergebyr + fragt + evt. BidHamr Beskyttelse.
- Fejler betalingen, har køberen **24 timer**. Betaler han ikke, annulleres handlen, køberen får en advarsel, og sælgeren kan tilbyde varen til næsthøjeste byder eller sætte den op igen.
- **Gebyrer: 5% til køberen og 5% til sælgeren.** Altid, uden minimum eller maksimum.
- **BidHamr Beskyttelse** er et frivilligt tilkøb på **3%** oveni købergebyret, mindst 20 kr. og højst 250 kr. Den dækker, hvis varen er gået i stykker under forsendelsen: køberen kan oprette en sag og sende varen retur, og BidHamr håndterer sagen. De 3% er en midlertidig pris – der skal laves et bedre prissystem senere.
- Ordet **"forsikring"** bruges aldrig – hverken i UI, mails, kode eller dokumenter. Det hedder **BidHamr Beskyttelse**. Heller ikke "garanti".
- **Køberen betaler fragten** og ser prisen, før han byder. Totalprisen vises, før man byder.
- Sælgeren får sine penge udbetalt til sin bankkonto via sin Stripe Connect-konto, minus sælgergebyret.
- Vi kører med **testpenge i Stripes testmiljø** indtil sidste fase før lancering.
- Handelsdata slettes aldrig. Afsluttede handler arkiveres, fordi kvitteringer, bedømmelser, DAC7 og bogføringsloven kræver, at de gemmes.

## Hvad der bevidst ikke er med

- **"Køb nu" findes ikke.** BidHamr er en ren auktionsside. Alt sælges ved bud. Det kan tages op igen efter lancering, men er ikke med ved lanceringen.
- **Ingen fortrydelsesret.** Sælgeren er privatperson, så forbrugerreglerne om 14 dages fortrydelsesret gælder ikke. Et køb kan ikke fortrydes. Det skal stå tydeligt på hver auktion.
- **Ingen saldo, intet wallet, ingen indbetaling før bud.** Køberen betaler med gemt kort, når han vinder.
- **Ingen skjult mindstepris.** Sælgeren sætter én synlig startpris, som er mindsteprisen.
- **Ingen bedømmelse af køberen.** Kun køberen bedømmer sælgeren.

## De fire kerneord

Alt design og al tekst skal måles på disse fire ord:

- **Troværdigt** – vi lover ikke mere, end vi holder. Reglerne står der, også de kedelige.
- **Professionelt** – ensartet design, ordentligt sprog, ingen halve løsninger.
- **Trygt** – brugeren kan altid se, hvor pengene og pakken er, og hvad der sker, hvis noget går galt.
- **Moderne** – enkelt, luftigt og hurtigt, og det virker på mobil først.

Designsystemet står i `DESIGN.md`. Retningen er valgt: skovgrøn som brandfarve med varm orange til knapper og accenter, serif-overskrifter og en forside bygget om et stort delt hero med søgefelt, tryghedsstribe, kategori-ikoner og "Slutter snart"-kort.

## Tidsplan

Hjemmeside og app skal være teknisk færdige inden udgangen af 2026. Hele 2027 går til marketing og møder. **Lancering juni 2027.** Rækkefølgen står i `ROADMAP.md`.
