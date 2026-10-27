# Plan mod lancering 1. marts 2027

Lavet 27. okt. 2026. **Mig** = Claude og agenterne. **Filip** = dig. Datoerne er mål, ikke løfter – rykker noget, rykker vi resten med.

## November 2026 – alt teknisk færdigt
**Mig**
- Gør dagens arbejde færdigt: måned 1-regel, fakturaer, skift af e-mail, kontaktinfo i beskrivelser, glidende gebyrer → review, samlet test, prod-migrationer (med dit ja).
- Fragt: koble DAO på via Shipmondo med rigtige nøgler, slå labels og retur til, test med forsendelser der aldrig indleveres.
- Appen: nyt TestFlight-build med al ny kode, CAPTCHA i appen, test alle app-punkter på telefon (fase 5 "mangler test på telefon"), Android-build.
- Admin: staff må ikke kunne spærres ude via login-loftet.

**Filip**
- Underskriv DAO-kontrakten (gælder fra 1. marts) og send Allans svar om Shipmondo videre.
- Advokat: send betingelser, privatlivspolitik og `jura/noter-til-advokat.md` (inkl. Cloudflare nr. 138-139).
- Revisor: fakturaer (Dinero), bogføring af Stripe-fakturaer (nr. 100) og DAC7.
- Resend: opgrader planen (kvoten slap op under test).
- Test firma-rejsen og opret auktion som nyt firma i almindelig browser.

## December 2026 – klar til rigtige penge
**Mig**
- Go-live-generalprøve i Stripe live (betalingsmetoder, webhooks, Connect, fakturaopsætning) – efter du har aktiveret kontoen.
- Indarbejd advokatens og revisorens svar.
- Sikkerhedsgennemgang nr. 2 af hele siden og appen, belastningstest, overvågning og backup/genskabelse.
- Appens sider i App Store og Google Play: tekster, skærmbilleder, privatlivsoplysninger.
- **Kodefrys 20. dec.**: kun fejlrettelser hen over jul.

**Filip**
- Aktivér Stripe live (firma- og bankoplysninger, ID).
- Idura/MitID i produktion.
- Dinero live.
- Google Play-udviklerkonto (og Apple Developer, hvis ikke på plads).

## Januar 2027 – lukket beta og marketing
**Mig**
- Lukket beta på bidhamr.dk med inviterede (beta-invitationer) og små rigtige handler.
- Ret fejl fra betaen hurtigt.
- Send appen til App Store- og Play-gennemgang (midt i januar).

**Filip**
- Start videoerne efter udgivelsesplanen og byg ventelisten.
- Onboard de første butikker (firmapakker), og sælg Ugens butik for marts.
- Møder med samarbejdspartnere.

## Februar 2027 – generalprøve
**Mig**
- Gå hele go-live-listen igennem (`HUSKELISTE.md`, `docs/GO-LIVE-STRIPE.md`, `docs/FRAGT.md`): alle flag og nøgler i Vercel og Supabase.
- Slå CAPTCHA og beskyttelse mod lækkede adgangskoder til.
- Sidste fulde test på produktion.
- **Kodefrys 20. feb.**

**Filip**
- Appen godkendt og klar til udgivelse 1. marts.
- Presse og marketing-push, firmaer klar med auktioner.

## 1. marts 2027 – lancering
- Slå `LANCERET`, `TILMELDING_AABEN` og `SEO_INDEKSERING` til (se `HUSKELISTE.md`), luk invitationsværnet, udgiv appen.
- Jeg holder øje med drift, betalinger og fejl hele dagen.
