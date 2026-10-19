# Prøv appen på din telefon

Sådan prøver du den nye BidHamr-app på din iPhone eller Android med Expo Go. Det tager cirka 10 minutter første gang.

Appen bruger altid **testdatabasen**. Der er ingen rigtige penge og ingen rigtige brugere, så du kan ikke ødelægge noget.

## Det skal du bruge

- Pc'en med to mapper:
  - `C:\Users\jeppe\Desktop\hamr` (hjemmesiden)
  - `C:\Users\jeppe\Desktop\bidhamr-app` (appen)
- Din telefon med **Expo Go**. Hent den nyeste version fra App Store eller Google Play. Appen bruger Expo SDK 57, så Expo Go skal være en version, der understøtter SDK 57. Har du en gammel Expo Go, så opdatér den.
- Telefonen og pc'en skal være på **samme wifi**.

## Trin 1: Start hjemmesiden på pc'en

Appen henter sine data gennem hjemmesiden, så den skal køre først.

1. Åbn en terminal i `hamr`-mappen.
2. Skriv `npm run dev` og tryk Enter.
3. Kig efter linjen **Network**. Den viser en adresse som fx `http://192.168.87.108:3000`. Skriv den ned.

Pc'ens adresse kan skifte, fx når du har genstartet routeren. Brug altid den adresse, `npm run dev` viser lige nu.

Hvis Windows Firewall spørger, om Node må tage imod forbindelser, så svar **Tillad** på private netværk.

Lad terminalen stå åben, mens du tester.

## Trin 2: Fortæl appen, hvor hjemmesiden er

1. Åbn filen `.env` i `bidhamr-app`-mappen.
2. Find linjen med `EXPO_PUBLIC_API_URL`, og ret den til adressen fra trin 1:

   ```
   EXPO_PUBLIC_API_URL=http://192.168.87.108:3000
   ```

   Brug din egen adresse – ikke den i eksemplet.
3. Gem filen.

Skriv aldrig `localhost` her. Telefonen kan ikke nå `localhost`, for det betyder telefonen selv.

## Trin 3: Start appen

1. Åbn en ny terminal i `bidhamr-app`-mappen.
2. Skriv `npx expo start` og tryk Enter.
3. Der kommer en QR-kode frem.
4. Scan QR-koden:
   - **iPhone:** brug Kamera-appen, og tryk på linket, der dukker op.
   - **Android:** åbn Expo Go, og tryk på "Scan QR code".
5. Appen åbner i Expo Go. Første gang kan det tage et minut.

Har du rettet i `.env`, mens appen kørte? Så stop `npx expo start` (tryk Ctrl+C) og start den igen.

### Virker wifi ikke?

På nogle netværk (fx på en arbejdsplads) kan telefonen ikke se pc'en. Så kan du starte appen med `npx expo start --tunnel` i stedet.

Bemærk: tunnelen hjælper kun appen. Hjemmesiden (port 3000) skal stadig kunne nås fra telefonen – enten på samme netværk eller gennem en tunnel til port 3000. Spørg Claude, hvis du får brug for det.

## Trin 4: Log ind

Log ind med testbrugeren **macbook@test.bidhamr.dk**. Adgangskoden står øverst i `hamr\supabase\seed.sql`.

## Det kan du prøve i Expo Go

- Forside
- Søgning
- Auktioner og bud
- Opret auktion med billeder
- Sælg
- Mine handler
- Chat
- Notifikationslisten
- Konto

## Det kan du ikke prøve i Expo Go endnu

Det her kræver den rigtige app-version (en såkaldt development build), som vi laver senere:

- **Betaling** – checkout, gemt kort, køb af boost og betaling af returfragt. Appen viser "Betaling kræver den rigtige app-version".
- **Push-notifikationer** på telefonen
- **MitID** – appen kan ikke sende dig videre til MitID og tilbage igen

Det er ikke en fejl, når de ting ikke virker i Expo Go.

## Tjekliste

- [ ] Log ind
- [ ] Søg efter noget
- [ ] Byd på en TEST-auktion
- [ ] Opret en auktion med et billede
- [ ] Skriv en besked i en chat
- [ ] Åbn Konto → Boost-point

## Når noget ikke virker

Tag et skærmbillede og send det til Claude.
