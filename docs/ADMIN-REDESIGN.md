# Admin-redesign – plan

Status: **plan, intet er bygget** (frontend-agent, 11. okt. 2026).
Roadmap: "Overskueligt og brugervenligt admin" og "Admin-kontrolpanel" (fase 6, Filip 12. okt. 2026).
Begge skal bygges **efter sikkerhedsnettet for pengene**. To andre agenter ændrer lige nu Admin → Penge og
pengelogikken (nødstop, godkendelse af udbetalinger, reserve, økonomioverblik). Planen rører derfor ikke
pengelogikken. Den beskriver kun, hvor deres resultater skal vises.

Bindende grundlag: `DESIGN.md` (farver, statusfarver 1.4, chips 7.5, mobil først 12), `ROADMAP-BESLUTNINGER.md`
(roller, sager, DSA, erhverv) og `CLAUDE.md`.

---

## 1. Nuværende tilstand

### 1.1 Alle admin-sider

Roller: **M** = medarbejder, **A** = admin, **C** = chef, **S** = sælger (erhverv, uden for hierarkiet).
"M+" betyder medarbejder og op (M, A og C). Adgangen tjekkes på hver side (`kraevSideRolle`, `getStaffRole`,
`kraevErhvervSide`). Menuen skjuler bare punkterne.

| Side (URL) | Formål | Adgang | Menugruppe i dag |
|---|---|---|---|
| `/admin` | Forside: "Kræver handling nu" + nøgletal for brugere og aktivitet (`admin_forside_tal()`) | M+ | Dagligt arbejde |
| `/admin/sager`, `/admin/sager/[id]` | Købers klager over en handel, anker, afventer retur, afgjorte. Afgørelse flytter penge | M+ (anke: A+) | Dagligt arbejde |
| `/admin/dsa`, `/admin/dsa/rapport` | DSA-anmeldelser af ulovligt indhold, klager over afgørelser, afsluttede. Gennemsigtighedsrapport | M+ / rapport A+ | Dagligt arbejde ("Anmeldelser og klager") |
| `/admin/rapporter` | Åbne anmeldelser af auktioner fra brugere | M+ | Dagligt arbejde |
| `/admin/opklarede-rapporter` | Rapporter opklaret de seneste 48 timer | M+ | (fane under Rapporter) |
| `/admin/bruger-rapporter` | Anmeldte chatbeskeder og profiler | M+ | (fane under Rapporter) |
| `/admin/rapport-arkiv` | Arkiv over rapporter | A+ | (fane under Rapporter) |
| `/admin/kontakt` | Henvendelser fra kontaktformularen | M+ | Dagligt arbejde |
| `/admin/chats`, `/admin/chats/[id]` | Samtaler mellem BidHamr og brugere | M+ | Dagligt arbejde |
| `/admin/handler`, `/admin/handler/[id]/chat` | Alle handler: markerede, hænger, fragt, aktive, alle. Handelschat | M+ (penge flyttes: A+) | Handler og brugere |
| `/admin/betalinger` | Betalinger, der er gået galt: fejlede udbetalinger/refusioner, forkerte beløb, auktioner uden handel, udbetalingskonti | M+ | Handler og brugere |
| `/admin/ubetalte` | Ubetalte vindere: advarsel eller afvisning | M+ | Handler og brugere |
| `/admin/kontolukninger` | Forslag om kontolukning efter 3 advarsler | A+ | Handler og brugere |
| `/admin/brugere`, `/admin/brugere/[id]` | Søg bruger, profil med faner (oversigt, auktioner, bud, anmeldelser, sager, chats), advar/suspendér/luk | M+ (moderation og lukning: A+) | Handler og brugere |
| `/admin/brugere/mistaenkelig` | Brugere, der rammer svindelreglerne | M+ | (fane under Brugere) |
| `/admin/auktioner` | Alle auktioner med søgning og filtre, moderation | A+ | Handler og brugere |
| `/admin/bedommelser` | Rapporterede og skjulte bedømmelser | M+ | Handler og brugere |
| `/admin/erhverv` (+ `firmaer`, `klager`, `dsa-klager`, `pakker`, `henvendelser/[id]`, `firmaer/[id]`, `klager/[id]`, `dsa-klager/[id]`) | Erhvervshenvendelser, firmaer, klager over firmaer, firmaers DSA-klager, pakker | C + S (pakker ændres kun af C) | Handler og brugere |
| `/admin/penge` | Indtjening, pengestrøm, afstemning mod Stripe, penge der holdes, fragttilskud | C | Overblik |
| `/admin/fakturaer` | Dinero-fakturaer, der kræver handling eller hænger | C | Overblik |
| `/admin/dac7` | DAC7-indberetning til Skattestyrelsen | C | Overblik |
| `/admin/medarbejder-log` | Log over staff-handlinger (M ser kun egne) | M+ | Overblik |
| `/admin/drift` | Besøg, alarmer, cron-rute, pg_cron, notifikationer, fejl på siden | A+ | Overblik |
| `/admin/medarbejdere` | Roller til staff | C | Indstillinger (foldet) |
| `/admin/venteliste` | Tilmeldinger til ventelisten + CSV | C | Indstillinger (foldet) |
| `/admin/beta` | Beta-invitationer (C åbner/lukker) | A+ | Indstillinger (foldet) |
| `/admin/beta-fejl` | Fejl meldt af beta-testere | A+ | Indstillinger (foldet) |

I alt **40 sider** (`page.tsx`). Chefen ser **23 menupunkter** i 4 grupper, admin 17, medarbejderen 12, sælgeren 1.

### 1.2 Hvad gør admin uoverskueligt i dag

**A. Navigation og menu**

1. **For mange punkter, flade grupper.** 23 punkter for chefen (`src/components/admin/AdminSidebar.tsx:61-127`).
   Ingen undermenuer, så alt står i samme niveau – også sider, der i praksis er faner af hinanden.
2. **Gruppenavne passer ikke til indholdet.**
   - "Overblik" (`AdminSidebar.tsx:100-111`) indeholder Penge, Fakturaer, DAC7, Medarbejder-log og Drift – men
     selve Forsiden (det egentlige overblik) står under "Dagligt arbejde" (`:66`).
   - "Handler og brugere" (`:86-99`) blander penge (Betalinger), moderation (Bedømmelser, Auktioner),
     brugeradministration (Kontolukninger) og Erhverv.
3. **Vigtige ting er gemt.** "Indstillinger" er foldet sammen som standard (`:115`), men indeholder
   **Beta-fejl**, som er noget, der skal handles på – og som ikke har en tæller.
4. **Samme emne, to menupunkter.** "Anmeldelser og klager" (`/admin/dsa`) og "Rapporter" er to menupunkter,
   men Rapporters faner linker selv til DSA (`src/components/admin/RapportFaner.tsx:15`). Man ved ikke, hvor en
   anmeldelse ligger. Bedømmelser er også en slags anmeldelse, men ligger i en tredje gruppe.
5. **Tællere uden alvor.** Alle menutal er ens røde (`AdminSidebar.tsx:357`). En DSA-sag over fristen ser ud
   som en ny kontaktformular. Beta-fejl, fakturaer og firmaklager har ingen tæller.
6. **Menuen følger ikke designet.** Mørkegrå `#111827` (`:453`, `:491`, `:499`) og "BidHamr" som orange tekst
   (`:372-373`, `:454`) i stedet for logoet `public/brand/bidhamr-logo.svg` og skovgrøn.
7. **8 tællerkald på hver sidevisning.** `src/app/admin/layout.tsx:32-48` kalder 8 server actions for
   menutallene, og forsiden henter de samme tal igen med `admin_forside_tal()` (`src/app/admin/page.tsx:21`).

**B. Navngivning**

8. "Rapporter" betyder både brugeres anmeldelser (`/admin/rapporter`) og DSA's gennemsigtighedsrapport
   (`/admin/dsa/rapport`).
9. "Klager" findes fire steder med forskellig betydning: sager (købers klage), DSA-klager (over vores
   afgørelse), erhvervsklager (over et firma) og erhvervs-DSA-klager (et firmas klage over vores afgørelse).
10. Fanen "Markerede" på Handler har nøglen `sager` (`src/app/admin/handler/page.tsx:80`), og sidens funktion
    hedder `AdminSager` (`:104`) – let at forveksle med Sager.
11. "Betalinger" handler kun om fejl. "Medarbejder-log" ser medarbejderen kun sine egne poster i.
12. Alle erhvervsfaner har samme titel "Erhverv" (`ADMIN_ERHVERV.menupunkt`, fx
    `src/app/admin/erhverv/klager/page.tsx:42`, `dsa-klager/page.tsx:48`), så man ikke kan se, hvor man er.

**C. Inkonsistente layouts**

13. **Fire forskellige stilarter for faner og filtre:**
    - understregede faner (`AdminFaner`, fx `dsa/page.tsx:377`, `brugere/[id]/page.tsx:262` – sidstnævnte
      har sin egen kopi i stedet for `AdminFaner`)
    - orange piller (`sager/page.tsx:83-86`, `handler/page.tsx:316-319`, `betalinger/page.tsx:148-152`,
      `ubetalte/page.tsx:107`, `kontolukninger/page.tsx:112`, `auktioner/page.tsx:209`)
    - sorte piller (`brugere/page.tsx:98`, `drift/page.tsx:625`)
    - grønne piller (`dsa/page.tsx:348`, `dac7/page.tsx:127`, `erhverv/page.tsx:61`, `erhverv/klager/page.tsx:98`)
    - grå segmentknap (`penge/page.tsx:607-619`).
    Faner (skift mellem undersider) og filtre (afgræns listen) ser derfor ens eller forskellige ud tilfældigt.
14. **Sidehoved uden fælles komponent** på Penge (`penge/page.tsx:592-623`), Fakturaer (`fakturaer/page.tsx:94-110`,
    bruger `text-gray-600` i stedet for neutral) og DAC7's fejltilstand (`dac7/page.tsx:91`, titel "DAC7" i stedet
    for "DAC7 – indberetning til Skattestyrelsen").
15. **Sidebredde varierer:** ingen grænse (handler, betalinger, penge, rapporter), `max-w-4xl` (brugere, chats),
    `max-w-5xl` (sager, erhverv, DAC7), `max-w-6xl` (drift). Brugerprofilen bruger `p-6` uden mobil-padding
    (`brugere/[id]/page.tsx:100`).
16. **Fem slags status-badges:** `StatusBadge`/`RolleBadge` med Tailwinds gule/røde/lilla
    (`src/components/admin/StatusBadge.tsx:11-12, 31-37`), Drifts egen `Badge` (`drift/page.tsx:59-71`),
    Beta-fejls `ALVOR_FARVE`/`STATUS_FARVE` (`beta-fejl/page.tsx:55-66`), `SagStatusBadge` og `HenvendelseStatusBadge`.
    Kun nogle bruger DESIGN.md's statusfarver (`succes`, `advarsel`, `fejl`, `info`).
17. **Fejlbokse i to stilarter:** `red-50/red-200/red-700` (`brugere/page.tsx:105`, `handler/page.tsx:301`) og
    `fejl-bg/fejl-kant/fejl-tekst` (`page.tsx:46`, `sager/page.tsx:106`).
18. **Kvitteringen efter en handling forsvinder.** `ConfirmDialog` kalder `visKvittering()`
    (`src/components/admin/ConfirmDialog.tsx:160`), men `<Statuslinje />` (som viser kvitteringen) er kun sat ind på
    `dsa/page.tsx:600` og `erhverv/dsa-klager/[id]/page.tsx:135`. Handler sender fem kvitteringer
    (`handler/page.tsx:438, 456, 473, 609, 638`), som aldrig vises. Komponenten hedder desuden "Statuslinje",
    som er det navn, den nye grøn/gul/røde linje skal have.

**D. Tabeller på mobil**

DESIGN.md afsnit 12: "Ingen vandret scroll. Test altid ved 360px." Disse sider bruger brede tabeller med vandret scroll:

19. `auktioner/page.tsx:220-221`, `rapporter/page.tsx:128-129`, `opklarede-rapporter/page.tsx:131-132`,
    `rapport-arkiv/page.tsx:112-113`, `medarbejdere/page.tsx:80-81`, `venteliste/page.tsx:47`,
    `brugere/[id]/page.tsx:567, 642` (auktioner og bud), `dsa/page.tsx:492-493` (`min-w-[720px]`),
    `drift/page.tsx:303, 409, 475, 567` (`min-w-[520px]`–`[720px]`).
20. Gode forbilleder findes allerede: Handler bliver til kort under `lg` (`handler/page.tsx:496-497`,
    `block lg:table`), DAC7 viser kort på mobil og tabel fra `sm` (`dac7/page.tsx:256`), og Sager er en kortliste
    (`sager/page.tsx:114`).

**E. Tomme tilstande, fejl og indlæsning**

21. Tomme tilstande er alt fra en centreret boks (`sager/page.tsx:110`) til en grå tabelcelle
    (`venteliste/page.tsx:66`, `dsa/page.tsx:539`) og en grøn succesboks (forsiden,
    `src/components/admin/forside/KraeverHandling.tsx:153-158`). Ingen fortæller, hvad man så kan gøre.
22. Kun 11 sider har egen `loading.tsx` (bl.a. betalinger, chats, drift, dsa, handler, penge, sager, ubetalte,
    beta-fejl). Resten viser det generelle skelet (`src/app/admin/loading.tsx`), som ikke ligner siden.

**F. Overlap og manglende detaljesider**

23. **Handler har ingen detaljeside.** Fra Fragt linker man til `/admin/handler?vis=alle&q=<id>`
    (`handler/page.tsx:345`). Det er en søgning, ikke en side. Siden henter desuden 500 handler og filtrerer i
    JavaScript (`:128`) – det samme gælder Rapporter og Opklarede (`limit(500)`, `rapporter/page.tsx:68`,
    `opklarede-rapporter/page.tsx:46`). Ventelisten henter alle rækker uden grænse (`venteliste/page.tsx:15-18`).
24. Penge-problemer er spredt: Betalinger (fejl), Penge (afstemning, holdte beløb), Fakturaer (Dinero), Drift
    (cron og alarmer) og nu nødstop og godkendelser hos penge-agenterne.
25. Forsidens "Kræver handling nu" er 11 ens gule kort (`KraeverHandling.tsx:64-143`) uden frist og alvor.
    Mangler: DSA-frister, beta-fejl, firmaklager, firmaers DSA-klager, kontaktformular, chats, bedømmelser,
    fakturaer, indsigelser og (nyt) godkendelser og nødstop.
26. Ubrugte komponenter: `StatCard.tsx` og `BarChart.tsx` bruges ingen steder. To CSV-knapper
    (`CsvKnap.tsx`, `CsvExportButton.tsx`) og to søgefelter (`AdminSearchInput.tsx`, `BrugerSearch.tsx`, plus
    `AdminFilters.tsx`) gør det samme.
27. Adgangstjek findes i tre varianter (`kraevSideRolle`, `getStaffRole` + `notFound()` i `penge/page.tsx:582`,
    `medarbejdere/page.tsx:19`, `venteliste/page.tsx:8`, `auktioner/page.tsx:42`, og `getStaffRole` +
    `redirect` i `handler/page.tsx:108`). Ikke et sikkerhedshul, men svært at gennemskue. Reviewer bør se på det,
    når siderne alligevel røres.

---

## 2. Ny informationsarkitektur

### 2.1 Principper

- **Seks grupper, højst 15 punkter for chefen.** Sider, der hører sammen, bliver **faner** på én side.
- **Navnet siger, hvad man gør der**, ikke hvad tabellen hedder.
- **Ingen URL'er ændres i trin 1–3.** Gamle adresser bruges i mails, logs og bogmærker. Fanerne linker bare til
  de eksisterende URL'er. Skal en adresse ændres senere, får den gamle en `redirect()`.
- De ens røde tællere bliver **farvet efter alvor**: rød = frist overskredet/kritisk, orange = venter.
  (Rød er tilladt her som undtagelse for tal-badges, se DESIGN.md 1.4.)

### 2.2 Ny menu

| Gruppe | Menupunkt (nyt navn) | Faner på siden (eksisterende URL) | Adgang |
|---|---|---|---|
| **Overblik** | Forside | – | M+ |
| **Handel og penge** | Handler | Hænger (`/admin/handler?vis=haenger`) · Fragt · Markeret af os (`vis=sager` → omdøbes `vis=markeret` med redirect) · Ubetalte vindere (`/admin/ubetalte`) · Alle handler | M+ |
| | Sager | Åbne · Anker · Afventer retur · Afgjorte (som i dag) | M+ |
| | Betalingsfejl | Kræver handling · Løste (`/admin/betalinger`) | M+ |
| | Penge | Overblik (`/admin/penge`) · Fakturaer (`/admin/fakturaer`) · DAC7 (`/admin/dac7`) – og penge-agenternes nye faner (godkendelser, nødstop) | C |
| **Brugere og sikkerhed** | Brugere | Søg (`/admin/brugere`) · Mistænkelig aktivitet · Kontolukninger (`/admin/kontolukninger`, A+) | M+ |
| | Henvendelser | Kontaktformular (`/admin/kontakt`) · Chats (`/admin/chats`) | M+ |
| **Indhold og moderation** | Anmeldelser | Ulovligt indhold (DSA) (`/admin/dsa`) · Auktioner (`/admin/rapporter`) · Chat og profiler (`/admin/bruger-rapporter`) · Bedømmelser (`/admin/bedommelser`) · Klager over afgørelser (`/admin/dsa?fane=klager`) · Afsluttet (`/admin/opklarede-rapporter`, `/admin/dsa?fane=afsluttede`, `/admin/rapport-arkiv` A+) | M+ |
| | Auktioner | (som i dag) | A+ |
| **Erhverv** | Erhverv | Henvendelser · Firmaer · Klager over firmaer · Firmaers klager (DSA) · Pakker | C + S |
| **Drift og indstillinger** | Drift | Overvågning (`/admin/drift`) · Gennemsigtighedsrapport (`/admin/dsa/rapport`) | A+ |
| | Handlingslog | (`/admin/medarbejder-log`; M ser "Mine handlinger") | M+ |
| | Medarbejdere | (som i dag) | C |
| | Beta-test | Invitationer (`/admin/beta`) · Fejl (`/admin/beta-fejl`) | A+ |
| | Venteliste | (som i dag) | C |

Resultat:

| Rolle | Punkter i dag | Punkter efter |
|---|---|---|
| Chef | 23 | 15 |
| Admin | 17 | 11 (Handler, Sager, Betalingsfejl, Brugere, Henvendelser, Anmeldelser, Auktioner, Drift, Handlingslog, Beta-test + Forside) |
| Medarbejder | 12 | 8 (Forside, Handler, Sager, Betalingsfejl, Brugere, Henvendelser, Anmeldelser, Handlingslog) |
| Sælger | 1 | 1 (Erhverv) – ingen gruppeoverskrift |

### 2.3 Hvad lægges sammen, flyttes eller skjules

- **Lægges sammen (som faner):** Rapporter + Opklarede + Chat og profiler + Arkiv + DSA + Bedømmelser →
  **Anmeldelser**. Kontaktformular + Chats → **Henvendelser**. Ubetalte vindere → fane under **Handler**.
  Kontolukninger → fane under **Brugere**. Fakturaer + DAC7 → faner under **Penge**. Beta-invitationer +
  Beta-fejl → **Beta-test**. Gennemsigtighedsrapport → fane under **Drift** (den er en årlig rapport, ikke
  dagligt arbejde).
- **Flyttes:** Forside til egen gruppe "Overblik". Penge/Fakturaer/DAC7 fra "Overblik" til "Handel og penge".
  Medarbejder-log til "Drift og indstillinger".
- **Omdøbes:** Betalinger → Betalingsfejl. Medarbejder-log → Handlingslog. Rapporter → Anmeldelser.
  Kontaktformular → Henvendelser. Fanen "Markerede" → "Markeret af os".
- **Skjules pr. rolle (uændret regler):** Penge-gruppen for alle andre end chef. Auktioner, Drift, Beta-test,
  Kontolukninger-fanen og Arkiv-fanen for medarbejder. Erhverv for alle andre end chef og sælger.
  En fane, man ikke har adgang til, vises ikke (siden tjekker stadig selv adgangen).
- **Tællere på faner**, ikke kun i menuen: menupunktet viser summen, og fanen viser sit eget tal.
- **Ingen foldet gruppe.** Med 15 punkter er der ikke brug for det, og så kan intet, der kræver handling, gemmes.
- **Mobil:** samme menu i en skuffe fra venstre (som i dag). Øverst i skuffen står statuslinjens farve og tekst,
  så man kan se "Alt kører" uden at åbne forsiden.
- **Udseende:** skuffe/sidebjælke i mørk skovgrøn (`--color-groen-mork`), logoet (`bidhamr-logo.svg`, hvid
  variant – **opgave: findes der en hvid udgave?**), rolle som lille chip, aktiv side med orange streg (som i dag).

---

## 3. Forsiden (kontrolpanel)

Rækkefølgen er prioriteten: først "er der noget galt?", så "hvad skal jeg gøre?", så tal.

### 3.1 Statuslinje (øverst, alle roller)

Én bred linje med farve, ikon og kort tekst. Ikonet er altid med, så farven aldrig er eneste signal (DESIGN 11).

| Farve | Hvornår | Tekst (pladsholder) |
|---|---|---|
| Grøn (`succes`) | Alle lamper grønne/grå, intet med høj alvor | "Alt kører" |
| Gul (`advarsel`) | Mindst én lampe gul, eller noget med høj alvor venter | "2 ting kræver din stillingtagen" |
| Rød (`fejl`) | Nødstop aktivt, en lampe rød, eller en lovpligtig frist er overskredet | "Udbetalinger stoppet" / "Betalings-cron har ikke kørt i 40 min." / "1 DSA-sag er over fristen" |

Ved flere røde ting vises den vigtigste, og "+2 mere" folder listen ud. Linjen linker til det, der er galt.
Medarbejderen ser kun de ting, han kan gøre noget ved – men nødstop vises altid (alle skal vide, at udbetalinger
står stille, så de kan svare brugerne).

### 3.2 Lamper (admin og chef)

Små kort med prik + navn + "sidst ok"-tid. Grå = ikke relevant (fx testdatabase, hvor cron ikke kaldes).

| Lampe | Grøn | Gul | Rød | Kilde |
|---|---|---|---|---|
| Betalings-cron | Sidste vellykkede kørsel < 15 min. | 15–30 min. | > 30 min. eller sidste kørsel fejlede | `drift_cron_koersler` (`CRON_ADVARSEL_MIN`, `src/lib/driftData.ts:18`) |
| Stripe-webhooks | Ingen webhook-fejl i 24 t, og ingen åbne "udeblevet event"-tilfælde | Webhook-fejl i 24 t | Åbent tilfælde om udeblevne events | `drift_fejl` (kilde `webhook`), `drift_tilfaelde`, `stripe_haendelser.behandlet` |
| Daglig afstemning | Kørt inden for 26 t, ingen afvigelser | Afvigelse under grænsen / ikke kørt i 26 t | Afvigelse over grænsen | **Penge-agenternes afstemning** (+ overvågningens tjek E i `src/lib/betaling/overvaagning.ts`) |
| Nødstop | Fra | – | Til ("Udbetalinger stoppet") | **Penge-agenternes nødstop** |
| Test eller live | Live-nøgle + produktionsdatabase | Test-nøgle + testdatabase (vises blå "Testmiljø", ikke fejl) | Blanding (live-nøgle mod testdatabase eller omvendt) | `noeglensTilstand()` (`src/lib/stripe.ts:14`), `erTestdatabase()` (`src/lib/miljoe.ts:5`) |
| Fragt | Shipmondo sat op, ingen fragtfejl i 24 t | Fragt kræver handling | Opsætning mangler / webhook fejler | fragtkonfiguration, `drift_fejl`, `tal.fragt` |
| Fakturering | Dinero sat op, ingen hængende > 2 t | Dokumenter kræver handling | Dinero ikke sat op / mange opgivne | `hentFakturaKonfig()`, `fakturaer` (som `fakturaer/page.tsx:56-90`) |
| MitID | Idura sat op (produktion i live) | Testopsætning i live | Ikke sat op | MitID-konfiguration (docs/MITID.md) |
| Alarmer | Modtager sat, alarmtjek < 15 min. | Tjek ældre end 15 min. | Ingen modtager | `hentAlarmStatus()`, `alarmModtagere()` (som `drift/page.tsx:120-125`) |

Konfigurationslamper (Stripe, Dinero, MitID, fragt) beregnes i serverkode og sendes kun som "ok/advarsel/fejl"
og en tekst til siden – aldrig nøgler eller URL'er.

### 3.3 Kræver handling

En **liste** (ikke 11 ens kort), sorteret efter alvor og derefter frist. Hver række: alvor-prik, titel, antal,
ældste/frist ("ældste: 3 dage" / "frist om 5 t"), kort forklaring, knap "Gå til". På mobil bliver rækken et kort.

| Kilde | Alvor | Frist | Link | Rolle |
|---|---|---|---|---|
| DSA-anmeldelser | Kritisk når over frist, høj når < 24 t | 7 dage (24 t for børnemisbrug/hadefuld tale) | `/admin/dsa` | M+ |
| DSA-klager over afgørelser | Kritisk når over frist | 14 dage | `/admin/dsa?fane=klager` | M+ (auktioner/lukkede konti: A+) |
| Indsigelser (Stripe-disputes) | Kritisk < 3 dage til Stripes svarfrist | Stripes `evidence_due_by` | `/admin/betalinger` (eller penge-agenternes side) | A+ |
| Åbne sager | Høj | Ældste sag | `/admin/sager` | M+ |
| Anker | Høj | Ankefrist | `/admin/sager?vis=anker` | A+ |
| Returfrist udløbet | Normal | – | `/admin/sager?vis=afventer_retur` | M+ |
| Godkendelser (udbetalinger) | Høj | Efter penge-agenternes regel | penge-agenternes side | efter penge-agenternes regel |
| Fremmede udbetalinger | Kritisk | – | penge-agenternes side | C |
| Hængende refusioner | Høj | Ældste | `/admin/betalinger` | M+ |
| Betalingsfejl og forkerte beløb | Høj | – | `/admin/betalinger` | M+ |
| Sælgers udbetalingskonto | Normal | – | `/admin/betalinger` | M+ |
| Ubetalte vindere (til godkendelse) | Normal | – | `/admin/ubetalte` | M+ |
| Forslag om kontolukning | Normal | – | `/admin/kontolukninger` | A+ |
| Betalt, ikke sendt / sendt, ikke modtaget / afhentning | Normal | `HAENGER_GRAENSER_DAGE` | `/admin/handler?vis=haenger` | M+ |
| Fragt kræver handling | Normal | – | `/admin/handler?vis=fragt` | M+ |
| Firmaklager (klager over et firma) | Høj | – | `/admin/erhverv/klager` | C + S |
| Firmaets klager (DSA-klage fra firma) | Kritisk når over frist | 14 dage | `/admin/erhverv/dsa-klager` | C + S |
| Fakturaer, der kræver handling | Normal | > 2 t | `/admin/fakturaer` | C |
| Beta-fejl | Høj ved "blokerer" | – | `/admin/beta-fejl` | A+ |
| Nye anmeldelser (auktioner, chat, bedømmelser) | Normal | – | `/admin/rapporter` m.fl. | M+ |
| Kontaktformular og chats uden svar | Normal | Ældste | `/admin/kontakt`, `/admin/chats` | M+ |

Tom liste: grøn boks "Der er intet, der venter på dig" + link "Se alle sager".

### 3.4 Pengestatus (kun chef)

Fire små kort og et link "Åbn Penge":
- Hos Stripe nu (tilgængeligt / afventer)
- Hos sælgerne for igangværende handler (holdes)
- Venter på godkendelse (antal og beløb) – fra penge-agenterne
- Nødstop: fra/til, med knap til Penge (selve knappen ligger kun på Penge, ikke på forsiden – en farlig handling
  skal ikke ligge ét klik fra startsiden)

**Bemærk:** `ROADMAP-BESLUTNINGER.md` (øverst) siger "Reserve-/bufferkonto bygges IKKE", mens roadmap-punktet
nævner "reserve". Kortet "Reserve" vises kun, hvis penge-agenterne bygger den. **Filip skal afklare det.**

Stripe-saldoen må ikke hentes live fra Stripe ved hver visning af forsiden (langsomt og rate-begrænset). Brug
det seneste tal fra afstemningen eller en cache på få minutter, og vis "opdateret kl. 14.05".

### 3.5 Nøgletal

Som i dag (`PeriodeKort`, `TilvaekstGraf`): nye brugere, nye auktioner, solgte varer (i dag / 7 dage / 30 dage).
Nyt: "Aktive auktioner lige nu". Chef: "Indtjening i dag" (fra Penge). Placeres nederst; på mobil foldet sammen
bag "Vis nøgletal".

### 3.6 Tjekliste før lancering (kun chef, forsvinder efter lancering)

Automatiske tjek (grøn/rød) + manuelle punkter fra roadmappen (kun tekst og link til ROADMAP, ingen database):
- Stripe live-nøgle og produktionsdatabase (lampe "Test eller live")
- Dinero live-regnskab, Idura-produktionsaftale, Shipmondo live
- Alarmmodtager og heartbeat sat, cron har kørt
- 2-trins-login for staff (roadmap "Admin på egen adresse")
- Manuelt: betingelser godkendt af advokat, CVR, DAC7 bekræftet af revisor

**Opgave til indhold-agenten:** den endelige tekst til tjeklisten og forklaringerne til hver lampe.

---

## 4. Fælles mønstre for alle undersider

### 4.1 Sideskelet `AdminSide`

Ny serverkomponent, som alle sider pakkes ind i: `mx-auto max-w-6xl space-y-5 p-4 sm:p-6` (detaljesider
`max-w-5xl`). Rækkefølge: sidehoved → faner → filtre/søgning → indhold → sideskift.

### 4.2 Sidehoved

`AdminSideHoved` findes og genbruges. Udvides med:
- `tilbage` (lille link over titlen på detaljesider, fx "← Sager")
- `handlinger` (højre side; på mobil under forklaringen i fuld bredde)
- forklaringen holdes på én–to linjer; længere hjælp i en `<details>` "Sådan bruger du siden"
  (**opgave til indhold-agenten**)

Penge, Fakturaer og DAC7 skal bruge den (punkt 14).

### 4.3 Faner og filtre

- **Faner** (skifter side/URL): kun `AdminFaner` (understreget, grøn). Får en `antal`-prop pr. fane med alvorsfarve.
  `brugere/[id]` og `RapportFaner`/`BrugereFaner`/`ErhvervFaner` bygges på den.
- **Filtre** (afgrænser listen): ny `AdminFilterChips` efter DESIGN 7.5 (grønne chips, `rounded-full`, min. 40 px
  høje, aktiv = `bg-groen text-white`). Erstatter de orange, sorte og grå piller (punkt 13). Orange bruges ikke
  længere til filtre – orange er til handlingsknapper.
- **Søgning:** `AdminSearchInput` (findes). `BrugerSearch` og `AdminFilters` lægges ind i den.
- Filtre og søgning ligger i URL'en (som i dag), så siden kan deles og genindlæses.

### 4.4 Liste, der bliver til kort på mobil

Ny `AdminListe` (serverkomponent) efter mønstret fra `handler/page.tsx:496` og `dac7/page.tsx:256`:
- Under `lg`: hver række er et kort: titel + status-badge øverst, 2–3 linjer metadata, hele kortet er et link.
- Fra `lg`: rigtig tabel med kolonneoverskrifter.
- Kolonnedefinition: `{ label, celle, mobil: "titel" | "meta" | "skjul" }`.
- Rækker, der kræver handling, får advarselsbaggrund (som `sager/page.tsx:120`).
- **Ingen vandret scroll** ved 360 px. Drifts tekniske tabeller (pg_cron, HTTP-svar) må undtagelsesvis scrolle,
  men inde i et kort med tydelig "Rul sidelæns".
- **Sideskift:** ny `AdminSideskift` (Forrige/Næste + "Side 2", som `sager/page.tsx:151-169`), 25 rækker pr. side.
  Handler, Rapporter, Opklarede, Kontakt og Venteliste flyttes fra "hent 300–500 og filtrér i JS" til
  sideskift og søgning i databasen.

### 4.5 Detaljevisning

- Mobil: én spalte. Fra `lg`: to spalter – indhold til venstre (beskrivelse, billeder, samtaler, log),
  "fakta" til højre (parter, beløb, status, frister) og handlingerne øverst i højre spalte.
- På mobil ligger de vigtigste handlinger i en bjælke i bunden (`sticky bottom-0`, over cookie-banneret via
  `--samtykke-hoejde`), fx "Afgør sagen".
- Nyt: **detaljeside for en handel** `/admin/handler/[id]` (i dag kun en søgning, punkt 23). Samler handel,
  betaling, fragt, sag, chat og log ét sted. Kræver ingen databaseændring – data hentes som på Handler i dag.

### 4.6 Handlinger med bekræftelse

`ConfirmDialog`, `AdminActionKnap` og `FlereHandlinger` findes og genbruges. Faste regler:
- Én primær handling pr. kort (orange). Resten under "Flere handlinger".
- Destruktive handlinger (afvis, luk konto, suspendér) bruger fareknap (DESIGN 6.5) og kræver begrundelse.
- Handlinger, der flytter penge, viser **beløbet og hvem der får det** i dialogen og skriver "Kan ikke fortrydes".
- Efter handlingen: kvittering. `<Statuslinje />` omdøbes til `<Kvittering />` og flyttes ind i
  `admin/layout.tsx`, så den virker på alle sider (retter punkt 18).

### 4.7 Tomme tilstande, fejl og indlæsning

- `AdminTom`: ikon + én sætning + evt. link ("Ingen åbne sager. Se afgjorte sager").
  Forskel på "intet endnu" og "intet passer til filteret" (med knap "Nulstil filter").
- `AdminFejl`: `role="alert"`, DESIGN-fejlfarver, tekst "X kunne ikke hentes. Prøv at genindlæse siden." Erstatter
  alle `red-50`-bokse.
- `loading.tsx` på alle listesider, bygget af et `AdminListeSkelet`, der ligner listen (sidehoved, faner,
  5 kortrækker).

### 4.8 Statusfarver

Én komponent `AdminBadge` med fem toner fra DESIGN 1.4:

| Tone | Token | Bruges til |
|---|---|---|
| `groen` | succes | løst, betalt, ok, aktiv |
| `gul` | advarsel | venter, advarsel, hænger |
| `roed` | fejl | fejlet, over frist, suspenderet, nødstop |
| `blaa` | info | i gang, testmiljø |
| `graa` | neutral | afsluttet, arkiveret, afvist |

`StatusBadge`, `RolleBadge`, Drifts `Badge`, Beta-fejls farver og `HenvendelseStatusBadge` bygges på den.
`SagStatusBadge` bruges også i kundedelen og må først ændres efter aftale. Rollechips: chef = skovgrøn,
admin = mørk skovgrøn kant, medarbejder = lys grøn, sælger = orange-lys – ingen lilla/blå uden for paletten.

### 4.9 Komponenter: genbrug, saml, slet

| Komponent | Plan |
|---|---|
| `AdminSideHoved`, `AdminFaner`, `RulAktivFane`, `ConfirmDialog`, `AdminActionKnap`, `FlereHandlinger`, `AdminSearchInput`, `PeriodeKort`, `TilvaekstGraf`, `KontoLukningKort`, `MitIdAdminKort`, `SagHandlinger`, `DsaKort` | Genbruges |
| `RapportFaner`, `BrugereFaner`, `ErhvervFaner`, egne faner i `brugere/[id]` | Bygges på `AdminFaner` |
| `BrugerSearch`, `AdminFilters` | Lægges ind i `AdminSearchInput` |
| `CsvKnap`, `CsvExportButton` | Samles til én |
| `StatusBadge`, `RolleBadge`, Drift-`Badge` | Bygges på ny `AdminBadge` |
| `Statuslinje` (kvittering) | Omdøbes `Kvittering`, flyttes til layout |
| `KraeverHandling` | Omskrives til liste med alvor og frist |
| `StatCard`, `BarChart` | Slettes (ubrugte) |
| **Nye:** `AdminSide`, `AdminFilterChips`, `AdminListe`, `AdminSideskift`, `AdminTom`, `AdminFejl`, `AdminListeSkelet`, `AdminBadge`, `DriftStatuslinje`, `StatusLampe`, `PengeStatus` | |

Alle nye komponenter er serverkomponenter, undtagen hvor der er interaktion (dialoger, søgefelt, mobilmenu).

---

## 5. Wireframes

### 5.1 Forside – computer (chef)

```
+------------------+------------------------------------------------------------------+
| [logo] BidHamr   |  Forside                                                         |
|  chip: Chef      |  Det vigtigste først. Opdateret 14.05.                           |
|                  |                                                                  |
| OVERBLIK         |  +------------------------------------------------------------+  |
| > Forside        |  | (!) GUL  2 ting kræver din stillingtagen          [Se dem] |  |
|                  |  +------------------------------------------------------------+  |
| HANDEL OG PENGE  |                                                                  |
|   Handler     3  |  Systemer                                                        |
|   Sager       2  |  [o Betalings-cron  ] [o Stripe-webhooks] [o Afstemning     ]    |
|   Betalingsfejl  |  [  ok 2 min. siden ] [  ok             ] [  kørt 06.00     ]    |
|   Penge          |  [o Nødstop: fra    ] [o Testmiljø      ] [o Fragt          ]    |
|                  |  [o Fakturering     ] [o MitID          ] [o Alarmer        ]    |
| BRUGERE OG       |                                                                  |
| SIKKERHED        |  Kræver handling                                                 |
|   Brugere        |  +------------------------------------------------------------+  |
|   Henvendelser 1 |  | (rød)  DSA-anmeldelse        1   over frist (2 t)  [Gå til]|  |
|                  |  | (gul)  Åbne sager            2   ældste: 3 dage    [Gå til]|  |
| INDHOLD OG       |  | (gul)  Beta-fejl, blokerer   1                     [Gå til]|  |
| MODERATION       |  | (grå)  Betalt, ikke sendt    3   > 5 dage          [Gå til]|  |
|   Anmeldelser  1 |  +------------------------------------------------------------+  |
|   Auktioner      |                                                                  |
|                  |  Penge (kun chef)                                [Åbn Penge ->]  |
| ERHVERV          |  [Hos Stripe   ] [Hos sælgerne ] [Til godkend. ] [Nødstop   ]    |
|   Erhverv        |  [12.400 kr    ] [38.900 kr    ] [2 · 1.850 kr ] [fra       ]    |
|                  |                                                                  |
| DRIFT OG         |  Nøgletal                         i dag  ·  7 dage  ·  30 dage   |
| INDSTILLINGER    |  [Nye brugere ] [Nye auktioner ] [Solgte varer ] [Aktive nu ]    |
|   Drift          |  [Tilvækst-graf ......................................... ]      |
|   Handlingslog   |                                                                  |
|   Medarbejdere   |  Før lancering (4 af 9 klar)                       [Vis alle v]  |
|   Beta-test      |                                                                  |
|   Venteliste     |                                                                  |
|------------------|                                                                  |
| Log ud           |                                                                  |
+------------------+------------------------------------------------------------------+
```

### 5.2 Forside – mobil 360 px (medarbejder)

```
+--------------------------------+
| [logo]          (o gul)  [=]   |   <- prik viser statuslinjens farve
+--------------------------------+
| Forside                        |
|                                |
| +----------------------------+ |
| | (!) 2 ting kræver din      | |
| |     stillingtagen          | |
| +----------------------------+ |
|                                |
| Kræver handling                |
| +----------------------------+ |
| | (rød) DSA-anmeldelse     1 | |
| | Over fristen med 2 t       | |
| | [        Gå til          ] | |
| +----------------------------+ |
| +----------------------------+ |
| | (gul) Åbne sager         2 | |
| | Ældste: 3 dage             | |
| | [        Gå til          ] | |
| +----------------------------+ |
|                                |
| > Vis nøgletal                 |
+--------------------------------+
```
Medarbejderen ser ingen systemlamper (kun statuslinjen), ingen penge og ingen lanceringsliste.

### 5.3 Sager – liste

```
Computer (fra lg)
+-------------------------------------------------------------------------------+
| Sager                                                                         |
| Køberen har klaget over en handel. Afgør, hvem der har ret.  [? Sådan gør du] |
|-------------------------------------------------------------------------------|
|  Åbne (2)  |  Anker (1)  |  Afventer retur  |  Afgjorte                       |  <- AdminFaner
|  ========                                                                     |
| [Søg på auktion, køber eller sælger ............]  (Beskyttelse) (Med billeder)|  <- søg + chips
|-------------------------------------------------------------------------------|
| Status      | Auktion            | Type            | Køber · Sælger  | Oprettet |
| [gul] Åben  | Sony PS5           | Ikke som beskr. | Anna · Jonas    | 3 dage   |
| [gul] Åben  | Cykel 28"          | Ikke modtaget   | Ole · Mette     | 1 dag    |
|-------------------------------------------------------------------------------|
|                         < Forrige    Side 1    Næste >                        |
+-------------------------------------------------------------------------------+

Mobil (under lg)
+--------------------------------+
| Sager                          |
| Køberen har klaget over ...    |
| Åbne (2) | Anker (1) | Afv ->  |   <- fanerne ruller, aktiv fane rulles frem
| [Søg ......................]   |
| (Beskyttelse) (Med billeder)   |
| +----------------------------+ |
| | [gul] Åben  [Beskyttelse]  | |
| | Sony PS5                   | |
| | Ikke som beskrevet         | |
| | Anna -> Jonas · 3 dage     | |
| +----------------------------+ |
| +----------------------------+ |
| | [gul] Åben                 | |
| | Cykel 28"                  | |
| | ...                        | |
| +----------------------------+ |
|  < Forrige   Side 1   Næste >  |
+--------------------------------+
```

### 5.4 Sager – detalje

```
Computer
+---------------------------------------------------------------------------+
| <- Sager                                                                  |
| Sag #1042 · Sony PS5                       [gul] Åben  [Beskyttelse]       |
| Køberen siger, varen ikke er som beskrevet. Pengene er frosset.           |
|---------------------------------------------------------------------------|
| Køberens beskrivelse               | Afgør sagen                          |
| "Controlleren virker ikke ..."     | [ Giv køber medhold  ] (orange)      |
|                                    | [ Giv sælger medhold ]               |
| Billeder (3) [ ][ ][ ]             | Flere handlinger v                   |
| Sælgerens pakkebilleder (2)        |--------------------------------------|
| Samtaler om sagen                  | Handlen                              |
| Log                                | Bud 1.200 kr · Total 1.326 kr        |
|                                    | Køber: Anna (link) · Sælger: Jonas   |
|                                    | Betalt 2. okt · Sendt 3. okt         |
|                                    | Ankefrist: -                         |
+---------------------------------------------------------------------------+

Mobil: én spalte i rækkefølgen titel -> fakta -> beskrivelse -> billeder ->
samtaler -> log, og en fast bjælke i bunden:  [      Afgør sagen      ]
```

### 5.5 Brugere – søg og profil

```
Liste (mobil)                         Profil (computer)
+--------------------------------+    +---------------------------------------------------------+
| Brugere                        |    | <- Brugere                                              |
| Find en bruger ...             |    | (avatar) Anna Hansen   [gul] 1 advarsel  [MitID ok]     |
| Søg | Mistænkelig | Lukninger  |    | anna@... · 20 12 34 56 · oprettet 3. sep 2026           |
| [Navn, e-mail, telefon, id ]   |    |                     [Åbn chat] [Advar] Flere handl. v   |
| (Alle)(Suspenderet)(Lukket)    |    |---------------------------------------------------------|
| (Advarsler)(Påmindelser)(Staff)|    | Oversigt | Auktioner (4) | Bud (12) | Bedømmelser | ... |
| +----------------------------+ |    |---------------------------------------------------------|
| | (av) Anna Hansen  [gul]    | |    | Advarsler og suspenderinger   | Nøgletal               |
| | anna@... · 20 12 34 56     | |    | 1 advarsel (12. sep): ...     | 14 handler · 4,8 ★     |
| | 1 advarsel                 | |    | Påmindelser: 0                | 0 sager                |
| +----------------------------+ |    | Auktioner/bud: AdminListe -> kort på mobil              |
+--------------------------------+    +---------------------------------------------------------+
```

---

## 6. Rækkefølge og omfang

Hvert trin kan bygges, reviewes, testes og flettes for sig. **Trin 1 og 2 rører ikke Penge-siden**, så de kan
begynde, mens penge-agenterne arbejder. Trin 3 venter på dem.

### Trin 1 – Fælles byggeklodser og menu (ingen database)

- Nye komponenter: `AdminSide`, `AdminBadge`, `AdminFilterChips`, `AdminTom`, `AdminFejl`, `AdminSideskift`,
  `AdminListeSkelet`. `AdminFaner` får tal pr. fane.
- `Statuslinje` → `Kvittering` i `admin/layout.tsx` (retter de tabte kvitteringer på Handler).
- Ny menu (afsnit 2.2) i `AdminSidebar.tsx` med logo, skovgrøn og alvorsfarvede tal. Ingen URL'er ændres.
- Slet `StatCard.tsx` og `BarChart.tsx`.
- Test: alle fire roller ser de rigtige punkter, mobilmenu ved 360 px, alle gamle URL'er virker.
- **Database:** nej. Menutallene bruger de eksisterende 8 kald indtil trin 3.

### Trin 2 – Undersiderne i ens opbygning (ingen database)

Side for side, i denne rækkefølge (mest brugt først): Sager → Handler (+ ny `/admin/handler/[id]`) →
Brugere (+ profil) → Anmeldelser (DSA, Rapporter, Bedømmelser som faner) → Henvendelser → Betalingsfejl →
Ubetalte/Kontolukninger → Auktioner → Erhverv → Drift/Log/Medarbejdere/Beta/Venteliste.
- Hver side: `AdminSide` + `AdminSideHoved` + faner + chips + `AdminListe` (kort på mobil) + tom/fejl/loading.
- Sideskift i databasen i stedet for `limit(500)` på Handler, Rapporter, Opklarede, Kontakt og Venteliste.
  Kan oftest gøres med `.range()` og `count` på de eksisterende tabeller; hvor søgningen i dag sker i JavaScript
  på tværs af tabeller (Handler: køber/sælger-navn), **kan der kræves en søge-RPC** (backend).
- Ingen ændring af hvad handlingerne gør – kun hvor de står og hvordan de ser ud.
- **Database:** måske én søge-RPC til Handler (backend-agent, testdatabasen først).

### Trin 3 – Kontrolpanel-forsiden (database)

Venter på, at penge-agenternes nødstop, godkendelser, afstemning og "fremmede udbetalinger" er flettet ind i `main`.
- **Ny `admin_status()`** (backend, `security definer`, kun `service_role`, ingen persondata), ét kald med:
  - tidspunkter: sidste ok/fejlede cron-kørsel, sidste Stripe-event, sidste afstemning og resultat, alarmtjek
  - åbne `drift_tilfaelde` pr. type, webhook-/fragtfejl i 24 t
  - nødstop til/fra (læses fra penge-agenternes tabel/indstilling)
  - alle "kræver handling"-tal med **ældste tidspunkt eller nærmeste frist** pr. kilde (afsnit 3.3), inkl.
    DSA-frister (`frist_kl`), beta-fejl pr. alvor, erhvervsklager og firma-DSA-klager, fakturaer, indsigelser
  - Indsigelsernes svarfrist fra Stripe: **tjek, om den gemmes i databasen i dag** – ellers skal backend
    tilføje en kolonne, der spejles fra webhooken
  - Erhvervstal tælles kun med, når den kaldende rolle er chef eller sælger (eller filtreres i serverkoden)
- Erstat de 8 tællerkald i `admin/layout.tsx` med det samme kald (eller en let `admin_taellere()`), så menu og
  forside altid viser ens tal.
- Serverkode `src/lib/admin/status.ts` lægger konfigurationslamperne til (Stripe-tilstand, Dinero, MitID, fragt,
  alarmmodtager) og beregner statuslinjens farve og tekst ét sted.
- Ny forside: `DriftStatuslinje`, `StatusLampe`, ny `KraeverHandling`-liste, `PengeStatus` (chef), nøgletal,
  lanceringstjekliste. Hver sektion i sin egen `<Suspense>`, så et langsomt Stripe-tal ikke holder resten tilbage.
- Reviewer: rolle-filtrering (medarbejder må ikke se pengetal eller erhvervstal), ingen hemmeligheder i svaret.
- **Database:** ja – `admin_status()` (+ evt. kolonne til indsigelsesfrist). Køres først på testdatabasen;
  produktion kræver Filips "ja".

### Trin 4 – Penge-hubben (efter penge-agenterne)

- Penge, Fakturaer, DAC7 og penge-agenternes nye sider samles som faner under **Penge** med fælles sidehoved og
  `AdminListe`. Kun opbygning og udseende – ingen ændring af pengelogik.
- Afstemmes med penge-agenternes resultat: navne på faner, hvor nødstop-knappen står, og hvem der godkender.
- **Database:** nej.

### Trin 5 – Oprydning og finpudsning (ingen database)

- `loading.tsx` til alle listesider, "Sådan bruger du siden"-tekster (indhold-agenten), saml CSV-knapper og
  søgefelter, ens adgangstjek (`kraevSideRolle` overalt – reviewer kigger med).
- Tester gennemgår hele admin som medarbejder, admin, chef og sælger ved 360 px og på computer.

### Åbne spørgsmål til Filip

1. **Reserve:** roadmappen nævner reserve, `ROADMAP-BESLUTNINGER.md` siger "bygges IKKE". Hvilken gælder?
2. Må medarbejderen se statuslinjen "Udbetalinger stoppet"? (Planen siger ja – så de kan svare brugerne.)
3. Er navnene i afsnit 2.2 i orden (især "Anmeldelser", "Henvendelser", "Betalingsfejl", "Handlingslog")?
4. Skal admin-menuen være skovgrøn (som footeren) eller blive mørk neutral som i dag?

### Opgaver til indhold-agenten

- Statuslinjens tekster for alle kombinationer, lampernes forklaringer, "Kræver handling"-forklaringer pr. kilde,
  "Sådan bruger du siden" pr. underside, tomme tilstande og lanceringstjeklisten.
