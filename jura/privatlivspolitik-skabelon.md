# SKABELON – Privatlivspolitik

> **Til indhold-agenten:** Dette er Filips skabelon (modtaget 6. oktober 2026). Den skal IKKE bruges ordret.
> Lav en fuld BidHamr-version i `jura/privatlivspolitik-udkast.md`, der beskriver præcis, hvad koden og databasen faktisk gør. Tjek koden, databasen og `.env`-variablerne for, hvilke leverandører der reelt bruges – skriv ikke leverandører på, som ikke bruges.
> Markér udkastet tydeligt: **"UDKAST – skal godkendes af advokat"**.
>
> **Kendte problemer i skabelonen, der SKAL rettes i udkastet:**
> - Fragtfirmaer: kun dem, der faktisk bruges (i dag GLS, evt. Shipmondo senere) – ikke PostNord/DAO, medmindre de bruges.
> - Mangler leverandører/databehandlere: Supabase (database, login, filer), Vercel (hosting), Resend (mails), Criipto (MitID), push-tjenester (Expo/Apple/Google), regnskabsprogram (Dinero el.lign., når det kommer), evt. besøgsstatistik og fejlovervågning. Skeln mellem **databehandlere** og **selvstændigt dataansvarlige** (fx Stripe).
> - Mangler retsgrundlag: **retlig forpligtelse** (art. 6, stk. 1, litra c – bogføringsloven og DAC7-indberetning til Skattestyrelsen), **legitim interesse** (litra f – svindelforebyggelse, sikkerhed, sager, advarsler, moderation, spamfilter, login fra ny enhed) og **samtykke** (litra a – cookies, push, evt. markedsføring).
> - Mangler hvilke oplysninger der behandles: navn, e-mail, telefon, adresse, MitID-verificering (gem aldrig CPR-nummer, medmindre det er påkrævet og godkendt af advokat), bud, auktioner, chatbeskeder, pakke- og sagsbilleder, bedømmelser, advarsler, IP-adresse/enhed, betalings- og udbetalingsstatus.
> - **DAC7**: sælgeres oplysninger indberettes til Skattestyrelsen, når grænserne er nået – skal fremgå tydeligt.
> - **Overførsel til lande uden for EU** (fx USA via Stripe, Vercel, Resend): hvilket grundlag (EU-US Data Privacy Framework / standardkontraktbestemmelser).
> - Opbevaring: konkrete frister pr. type (profil, chat, sagsbilleder, logs, handelsdata 5 år efter regnskabsårets udløb, slettede konti).
> - Rettigheder: tilføj dataportabilitet, begrænsning, indsigelse og ret til at trække samtykke tilbage. Link til datatilsynet.dk.
> - Deling mellem køber og sælger: adresse og telefon vises aldrig offentligt – kun det nødvendige deles efter handlen (se ROADMAP-BESLUTNINGER.md).
> - Henvis til en separat cookiepolitik.
> - Udfyld dataansvarlig med firmanavn, CVR og adresse, når CVR er på plads.

---

PRIVATLIVSPOLITIK (GDPR) FOR [PLATFORMSNAVN]

## 1. Dataansvarlig
[Platformsnavn] er dataansvarlig for behandlingen af dine personoplysninger. Du kan kontakte os på: [E-mailadresse].

## 2. Formål og retsgrundlag for behandlingen
Vi behandler dine personoplysninger for at kunne:
- Oprette og administrere din brugerprofil (Opfyldelse af kontrakt – GDPR art. 6, stk. 1, litra b).
- Formidle auktioner, budgivning samt advisere dig, når du har vundet eller tabt en auktion (Opfyldelse af kontrakt).
- Facilitere fragt og levering af vundne varer (Opfyldelse af kontrakt).

## 3. Videregivelse af personoplysninger til tredjeparter
For at kunne drive platformen og levere vores services, videregiver vi oplysninger til følgende betroede samarbejdspartnere:
- Betaling (Stripe): Når du betaler eller modtager penge på platformen, indtastes dine betalingsoplysninger direkte hos vores eksterne betalingsformidler, Stripe. [Platformsnavn] modtager, ser eller gemmer ikke dine kortoplysninger eller bankkontonumre. Stripe behandler disse data som selvstændig dataansvarlig i overensstemmelse med deres egne sikkerhedsstandarder (PCI-DSS).
- Fragtudbydere (PostNord, DAO og GLS): Når der købes fragt via vores integrerede fragtløsning, videregives købers navn, adresse, e-mail og telefonnummer til det valgte fragtfirma (PostNord, DAO eller GLS) samt til sælgeren, så pakken kan sendes.
- Sælger/Køber: Ved en vunden auktion vil de nødvendige kontaktoplysninger blive delt mellem de to involverede parter for at kunne gennemføre handlen.

## 4. Opbevaring og sletning
Vi opbevarer dine oplysninger, så længe din brugerprofil er aktiv. Hvis du sletter din profil, sletter eller anonymiserer vi dine data, medmindre vi er lovmæssigt forpligtet til at gemme dem (f.eks. transaktionsdata i 5 år i henhold til bogføringsloven).

## 5. Dine rettigheder
Du har til enhver tid ret til at få indsigt i, hvilke oplysninger vi behandler om dig, få rettet forkerte oplysninger, eller bede om at få dine oplysninger slettet. Du har desuden ret til at klage over vores behandling til Datatilsynet.
