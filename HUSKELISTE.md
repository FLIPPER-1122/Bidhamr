# Huskeliste til Filip

## MitID (Idura) – før det går live (se docs/MITID.md, "Go-live")
- **www.bidhamr.dk SKAL omdirigere til bidhamr.dk** (Vercel → Project → Settings → Domains: sæt `bidhamr.dk` som primært domæne og `www.bidhamr.dk` til "Redirect to bidhamr.dk"). Ellers virker MitID ikke for dem, der kommer ind via www (cookien sættes på www, men Idura sender tilbage til bidhamr.dk).
- Idura: opret produktions-application, callback `https://bidhamr.dk/api/mitid/callback`, godkend databehandleraftalen og MitID-ansøgningen.
- Vercel-variabler: `CRIIPTO_DOMAIN`, `CRIIPTO_CLIENT_ID`, `CRIIPTO_CLIENT_SECRET`, `MITID_HASH_NOEGLE` (ny, tilfældig, mindst 32 tegn – må aldrig skiftes).
- (Lokalt er `MITID_HASH_NOEGLE` allerede sat i `.env.local`.)
- Før lancering (fra reviewer): brug et verificeret Universal Link/App Link (`https://bidhamr.dk/...`) som returadresse for appen i stedet for `bidhamr://`, og kør `mitid_flow_oprydning` fra betalings-cron, så MitID-data fra uafsluttede app-forløb slettes efter 5 min.
- Kør `20261013010000_mitid.sql` i produktion (dit "ja") først, når appen kan MitID (BHV01 + `/api/mitid/app` + `/api/mitid/app/afslut`).

## Mail på bidhamr.dk (når erhvervskonto og CVR er på plads)
- Google Workspace **Starter**, **1 bruger**, gerne **månedlig** betaling: opret `filip@bidhamr.dk`
- Opret `support@bidhamr.dk`, `erhverv@bidhamr.dk` og `faktura@bidhamr.dk` som gratis **grupper** i Google Admin (erhverv@ bruges af firmaer – Filip, 7. okt. 2026)
- Tilføj Googles MX/TXT-poster hos One.com – **slet ingen** eksisterende poster (Resend/Vercel), og der må kun være **én** SPF-post (flet dem)
- Skift faktura-mail hos Stripe, Vercel, Supabase, Google, One.com, Resend m.fl. til `faktura@bidhamr.dk`

---

# Tidligere noter

Testdatabasen er sat op (commit 3e22009). Det her mangler:

## Gør først (5 min)
1. **Udfyld to felter i `.env.local`** med nøglerne fra Supabase → **Bidhamr Test** (IKKE "Hamr") → Project Settings → API Keys:
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_…`-nøglen (gammelt navn: `NEXT_PUBLIC_SUPABASE_ANON_KEY` med "anon public"-nøglen)
   - `SUPABASE_SECRET_KEY` = `sb_secret_…`-nøglen (gammelt navn: `SUPABASE_SERVICE_ROLE_KEY` med "service_role"-nøglen)
   - Se `.env.example` for alle navne.
2. **Genstart dev-serveren** (stop `npm run dev` og start den igen).
3. **Log ind på localhost med `chef@test.bidhamr.dk`** – adgangskoden står øverst i `supabase/seed.sql`. Din egen konto findes ikke i testdatabasen.
4. Tjek at designet og coming-soon-siden ser rigtige ud. Er du tilfreds: commit og push, og sæt `[x]` ved de færdige fase 0-punkter i `ROADMAP.md`.

## Tre beslutninger, Claude Code venter på
1. **Skal "gaten" kunne åbnes på testdatabasen?** I dag kommer kun staff forbi coming-soon, så almindelige testbrugere (køber/sælger) kan ikke teste som rigtige brugere. Anbefaling: ja – åbn gaten kun på testdatabasen, aldrig på bidhamr.dk.
2. **Slet det fejlende cron-job i produktion.** Jobbet `afslut-auktioner` fejler hvert minut (pg_net er ikke installeret). Det rigtige job `afslut-udloebne-auktioner` virker. Anbefaling: ja, slet det – det kræver dit ja, fordi det er produktion.
3. **Stop mails fra dev-serveren.** Resend sender stadig mails fra localhost til falske `@test.bidhamr.dk`-adresser. Mange mails, der ikke kan leveres, kan skade bidhamr.dk's omdømme som afsender, så dine rigtige mails havner i spam. Anbefaling: slå mails fra på testdatabasen (log dem i stedet), eller send dem kun til din egen mail.

## Godt at vide
- Produktion indeholdt tabeller og kolonner, der aldrig stod i en migration (formentlig lavet direkte i Supabase til appen). Det er nu indfanget i `20260930130000_indfang_prod_drift.sql`. **Fremover: lav ikke ændringer direkte i Supabase til appen** – bed Claude Code lave en migration, så web, app og testdatabase holder sig i trit.
- Næste store skridt er **fase 1: betalingen med Stripe**. Tjek mailen for svar fra Stripes team først.

Svar til Claude Code, når du har besluttet dig, fx:
> 1. Ja, åbn gaten kun på testdatabasen. 2. Ja, slet cron-jobbet afslut-auktioner i produktion. 3. Slå mails fra i dev – log dem i stedet.
