# Beta-test – fejlmelding og spørgeskema

To skabeloner til beta-testen (se `docs/BETA-TEST.md`):

1. **Fejlmelding** – bruges under testen. Kan sendes som mail eller sættes op som Google Forms.
2. **Spørgeskema** – sendes, når testen er slut.

Hvert spørgsmål har en type, der findes i Google Forms. Teksten kan kopieres direkte ind.

---

## 1. Fejlmelding

### Som mail (kopiér og udfyld)

```
Emne: Fejl – [kort beskrivelse, fx "Kan ikke betale"]

Navn eller e-mail på din BidHamr-konto:
Dato og tidspunkt:
Side eller link:
Telefon eller computer (model):
Browser:

Hvad gjorde du?

Hvad skete der?

Hvad havde du regnet med?

Kan du gøre det igen og få samme fejl? (Ja / Nej / Har ikke prøvet)

Hvor slemt er det?
( ) Jeg kan ikke komme videre
( ) Jeg kan komme videre, men det er besværligt
( ) Det er en lille ting, fx en tekst

Skærmbillede: (vedhæft)
```

### Som Google Forms

**Titel:** Meld en fejl – BidHamr beta
**Beskrivelse:** Tak, fordi du melder fejlen. Jo mere præcist du skriver, jo hurtigere kan vi rette den. Brug aldrig rigtige kortoplysninger eller dit CPR-nummer i formularen.

| Nr. | Spørgsmål | Type i Google Forms | Svarmuligheder | Påkrævet |
|---|---|---|---|---|
| 1 | E-mail på din BidHamr-konto | Kort svar (validering: e-mail) | – | Ja |
| 2 | Hvornår skete det? | Dato + Klokkeslæt | – | Ja |
| 3 | Hvilken side var du på? | Multiple choice | Opret konto / MitID / Forside eller søgning / Auktionsside og bud / Betaling (checkout) / Opret auktion / Udbetalingskonto (Stripe) / Handelssiden (send, modtag, godkend) / Sag eller anke / Beskeder / Min konto / Andet | Ja |
| 4 | Link til siden (hvis du har det) | Kort svar | – | Nej |
| 5 | Hvad gjorde du? | Afsnit | – | Ja |
| 6 | Hvad skete der? | Afsnit | – | Ja |
| 7 | Hvad havde du regnet med? | Afsnit | – | Nej |
| 8 | Hvad brugte du? | Multiple choice | iPhone / Android / Computer (Windows) / Computer (Mac) / Tablet / Andet | Ja |
| 9 | Model, fx "iPhone 13" eller "Samsung Galaxy S22" | Kort svar | – | Nej |
| 10 | Browser | Multiple choice | Safari / Chrome / Samsung Internet / Firefox / Edge / Ved ikke / Andet | Ja |
| 11 | Sker det igen, hvis du prøver? | Multiple choice | Ja, hver gang / Nogle gange / Nej / Har ikke prøvet | Ja |
| 12 | Hvor slemt er det? | Multiple choice | Jeg kan ikke komme videre / Jeg kan komme videre, men det er besværligt / Det er en lille ting, fx en tekst | Ja |
| 13 | Skærmbillede | Filupload (kræver Google-login – ellers send det på mail til beta@bidhamr.dk) | – | Nej |

---

## 2. Spørgeskema efter testen

**Titel:** Hvordan var det at bruge BidHamr?
**Beskrivelse:** Tak, fordi du var med i beta-testen. Spørgeskemaet tager ca. 5 minutter. Der er ingen forkerte svar – vi vil gerne høre det ærlige.

| Nr. | Spørgsmål | Type i Google Forms | Svarmuligheder | Påkrævet |
|---|---|---|---|---|
| 1 | Hvad har du prøvet? | Afkrydsningsfelter | Oprettet en konto / Bekræftet med MitID / Oprettet en udbetalingskonto / Oprettet en auktion / Budt / Brugt "Byd automatisk" / Vundet og betalt / Sendt en vare / Modtaget og godkendt en vare / Oprettet en sag / Anket en afgørelse / Skrevet en besked / Fulgt en sælger / Downloadet mine data / Ændret notifikationer | Ja |
| 2 | Hvor nemt var det at bruge BidHamr alt i alt? | Lineær skala 1-5 (1 = meget svært, 5 = meget nemt) | – | Ja |
| 3 | Hvor gik du i stå, eller hvad var svært at forstå? | Afsnit | – | Nej |
| 4 | Var det tydeligt, hvad du skulle betale i alt, før du bød? | Multiple choice | Ja, helt / Delvist / Nej / Bød ikke | Ja |
| 5 | Forstod du, hvad BidHamr Beskyttelse dækker? | Multiple choice | Ja / Delvist / Nej / Lagde ikke mærke til den | Ja |
| 6 | Hvor trygt føltes det at handle med fremmede på BidHamr? | Lineær skala 1-5 (1 = slet ikke trygt, 5 = meget trygt) | – | Ja |
| 7 | Hvordan var fristerne (48 timer til at betale, 5 dage til at sende, 48 timer til at oprette en sag)? | Multiple choice | Passende / For korte / For lange / Lagde ikke mærke til dem | Ja |
| 8 | Hvis du har brugt Vinted, DBA eller Tradera: hvordan er BidHamr i forhold til dem? | Multiple choice | Bedre / Lige så godt / Dårligere / Har ikke brugt dem | Ja |
| 9 | Hvor sandsynligt er det, at du vil bruge BidHamr, når siden åbner? | Lineær skala 0-10 (0 = slet ikke, 10 = helt sikkert) | – | Ja |
| 10 | Er der andet, du vil fortælle os? Fx hvad der gjorde det trygt eller utrygt, eller hvad du savnede. | Afsnit | – | Nej |

**Tak-tekst efter indsendelse (Google Forms → Indstillinger → Bekræftelsesmeddelelse):**
Tak for dine svar og for din hjælp i testen. Vi bruger dem til at gøre BidHamr bedre, før siden åbner.
