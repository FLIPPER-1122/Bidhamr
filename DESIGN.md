# DESIGN.md – BidHamrs designsystem

Kilde: `ROADMAP-BESLUTNINGER.md` afsnit 8 og **mockup D** ("D · Blanding B+C, grøn") i `mockups/forside-mockups.html`.
Kerneord: **troværdigt, professionelt, trygt, moderne.**

Denne fil er bindende for alle agenter og alle nye sider. Bygger du noget, der ikke er beskrevet her, så vælg
den nærmeste beskrevne værdi – opfind ikke nye farver, radier eller skriftstørrelser.

Markeringer i dokumentet:
- **[MOCKUP]** = værdien står direkte i mockup D.
- **[FORSLAG]** = mit faglige valg, som Filip skal sige ja eller nej til.

---

## 1. Farver

### 1.1 Brandfarver

| Navn | Hex | Token | Bruges til |
|---|---|---|---|
| Skovgrøn (panel) | `#1E5E4A` | `--color-groen` | Store flader: hero-panel, footer, mørke sektioner. Tekst på skovgrøn er hvid. **[MOCKUP]** |
| Mørk skovgrøn | `#154537` | `--color-groen-mork` | Tekst/ikoner på lys grøn baggrund, hover på grønne flader, overskrifter i tryghedsstriben. **[MOCKUP]** |
| Lys grøn | `#E8F2EE` | `--color-groen-lys` | Rolige baggrunde: tryghedsstribe, kategori-ikoner, sektionsbaggrunde, badges. **[MOCKUP]** |
| Orange | `#E8772E` | `--color-orange` | Primær handling: knapper, søgeknap, accenter, "slutter snart"-timer. **[MOCKUP]** |
| Orange mørk | `#C75F1C` | `--color-orange-mork` | Hover/active på orange knapper. **[FORSLAG]** (ikke i mockup) |
| Orange lys | `#FBEFE6` | `--color-orange-lys` | Sjælden: baggrund bag orange ikon/badge. **[MOCKUP]** (fra variant C/E) |

Orange bruges **sparsomt** – én primær knap pr. sektion. Grøn er fladen, orange er handlingen.

### 1.2 Neutrale

| Navn | Hex | Token | Bruges til |
|---|---|---|---|
| Hvid | `#FFFFFF` | `--color-flade` | Sidens baggrund, kort, felter **[MOCKUP]** |
| Tekst | `#1A1A1A` | `--color-tekst` | Brødtekst og overskrifter **[MOCKUP]** |
| Tekst dæmpet | `#555555` | `--color-tekst-daempet` | Underrubrikker, beskrivelser **[MOCKUP]** |
| Tekst svag | `#777777` | `--color-tekst-svag` | Metatekst, "14 bud", tidsstempler **[MOCKUP]** |
| Pladsholder | `#888888` | `--color-pladsholder` | Pladsholdertekst i søgefelt/inputs **[MOCKUP]** |
| Kant | `#EEEEEE` | `--color-kant` | Kort-kant, sektionsskel, header-bund **[MOCKUP]** |
| Kant stærk | `#D6D6D6` | `--color-kant-staerk` | Inputkant, søgefeltets kant **[MOCKUP]** |
| Billed-fallback | `#DDDDDD` | `--color-skelet` | Tom billedflade / skeleton **[MOCKUP]** |

### 1.3 Den gamle røde skal udfases

**`#E63946` må ikke bruges i nyt arbejde.** Den ligger stadig som `--brand` i `src/app/globals.css` og
bliver brugt i eksisterende komponenter. Rører du en fil, der bruger den, så skift den til `--color-orange`
(handling) eller `--color-groen` (flade). Årsagen: farven ligger for tæt på den største danske konkurrent.
Rød må kun forekomme som fejlfarven i 1.4 – og det er en anden, mørkere rød.

### 1.4 Statusfarver **[FORSLAG]** – ingen af disse står i mockuppen

| Status | Baggrund | Kant | Tekst/ikon | Bruges til |
|---|---|---|---|---|
| Succes | `#E8F2EE` | `#B9D8CC` | `#154537` | "Betaling gennemført", "Handel afsluttet". Genbruger den lyse grøn, så succes føles som brandet. |
| Advarsel | `#FEF3E2` | `#F5D9B0` | `#8A4210` | "Auktionen slutter om 5 min", "Mangler MitID". |
| Fejl | `#FDECEC` | `#F3C4C4` | `#A32020` | Valideringsfejl, afvist betaling. Bevidst **mørkere og mindre mættet end `#E63946`**, så farven læses som en fejl og ikke som et brand. |
| Info | `#EDF3F8` | `#C9DCEB` | `#1F4E79` | Neutrale oplysninger, "Bud er bindende". |

Fejlfarven bruges **kun** til fejl – aldrig til knapper, tags eller priser.

### 1.5 Semantiske roller i auktions-UI **[FORSLAG]**

- Pris / aktuelt bud: `--color-tekst`, fed.
- **Totalpris (bud + gebyr + fragt): altid synlig, fed, `--color-tekst`, med en linje i
  `--color-tekst-daempet` der specificerer delene.** Den må aldrig være mindre fremhævet end budbeløbet.
- Timer normal: hvid flade, `--color-tekst` **[MOCKUP]**.
- Timer "slutter snart" (under 1 time): `--color-orange` med hvid tekst **[MOCKUP]**.
- "BidHamr Beskyttelse"-badge: lys grøn flade, `#154537` tekst, skjold-ikon. (Ordet "forsikring" må ikke bruges.)

### 1.6 Tailwind v4-opsætning

Læg dette i `src/app/globals.css` (erstatter det nuværende `--brand`-tema):

```css
@import "tailwindcss";

@theme {
  --color-groen:          #1E5E4A;
  --color-groen-mork:     #154537;
  --color-groen-lys:      #E8F2EE;
  --color-orange:         #E8772E;
  --color-orange-mork:    #C75F1C;
  --color-orange-lys:     #FBEFE6;

  --color-flade:          #FFFFFF;
  --color-tekst:          #1A1A1A;
  --color-tekst-daempet:  #555555;
  --color-tekst-svag:     #777777;
  --color-pladsholder:    #888888;
  --color-kant:           #EEEEEE;
  --color-kant-staerk:    #D6D6D6;
  --color-skelet:         #DDDDDD;

  --color-succes-bg: #E8F2EE;   --color-succes-kant: #B9D8CC;   --color-succes-tekst: #154537;
  --color-advarsel-bg: #FEF3E2; --color-advarsel-kant: #F5D9B0; --color-advarsel-tekst: #8A4210;
  --color-fejl-bg: #FDECEC;     --color-fejl-kant: #F3C4C4;     --color-fejl-tekst: #A32020;
  --color-info-bg: #EDF3F8;     --color-info-kant: #C9DCEB;     --color-info-tekst: #1F4E79;

  --font-serif: var(--font-fraunces);
  --font-sans:  var(--font-inter);
}
```

Brug derefter almindelige Tailwind-klasser: `bg-groen`, `text-groen-mork`, `bg-orange`, `border-kant`,
`bg-groen-lys`, `text-tekst-daempet`.

---

## 2. Skrifttyper

- **Fraunces** – alle overskrifter (h1–h3) og store beløb i hero. Vægt **600**. Variabel optisk størrelse
  `opsz 9..144`. Klasse: `font-serif`. **[MOCKUP]**
- **Inter** – al brødtekst, knapper, labels, felter, metatekst, navigation, tabeller. Vægte **400, 500, 600, 700**.
  Klasse: `font-sans`. **[MOCKUP]**

Vægtregler:
- 400: brødtekst
- 500: navigation, links, labels
- 600: knapper, badges, h4, timere, alle Fraunces-overskrifter
- 700: priser og beløb

Indlæs via `next/font/google` i `src/app/layout.tsx` (ikke via `<link>` til Google), så der ikke laves
eksterne kald ved hvert sidevisning:

```ts
import { Inter, Fraunces } from "next/font/google";
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], weight: ["600"], variable: "--font-fraunces", display: "swap" });
```

Fallback-kæder: serif → `Fraunces, Georgia, serif`. Sans → `Inter, system-ui, sans-serif` **[MOCKUP]**.

---

## 3. Typografiskala

Desktop-værdierne for h1/h2/h3, brødtekst, pris og metatekst kommer fra mockup D. Mobil-værdierne er **[FORSLAG]**.

| Rolle | Mobil | Desktop | Vægt | Linjehøjde | Skrift |
|---|---|---|---|---|---|
| h1 (hero) | 30px | **42px** **[MOCKUP]** | 600 | 1.1 **[MOCKUP]** | Fraunces |
| h1 (almindelig side) | 26px | 32px | 600 | 1.2 | Fraunces |
| h2 (sektion) | 20px | **22px** **[MOCKUP]** | 600 | 1.25 | Fraunces |
| h3 (underafsnit) | 17px | 18px | 600 | 1.3 | Fraunces |
| h4 (mindre overskrift) | 15px | 15px | 600 | 1.4 | Inter |
| Hero-underrubrik | 16px | **17px** **[MOCKUP]** | 400 | 1.5 **[MOCKUP]** | Inter |
| Brødtekst | 15px | **15px** **[MOCKUP]** | 400 | 1.55 | Inter |
| Brødtekst lille | 14px | **14px** **[MOCKUP]** | 400 | 1.5 | Inter |
| Pris / beløb | 18px | **18px** **[MOCKUP]** | 700 | 1.2 | Inter |
| Pris stor (auktionsside) | 26px | 30px | 700 | 1.2 | Inter |
| Metatekst ("14 bud") | 12px | **12px** **[MOCKUP]** | 400 | 1.4 | Inter |
| Label / chip / timer | 13px | **13px** **[MOCKUP]** | 500–600 | 1.3 | Inter |

Regler:
- Ingen negativ sporing (letter-spacing). Mockup D's h1 bruger ikke sporing – det gør kun de forkastede varianter.
- Brødtekst må aldrig gå under **14px**, metatekst aldrig under **12px**.
- Læselængde på lange tekster: maks. `max-w-[65ch]`.
- Tailwind: `text-[15px]` er i orden, men foretræk `text-sm` (14) / `text-base` (16), hvor det passer.

---

## 4. Afstande

En **4px-skala**. Brug kun disse trin – ingen løse tal.

| Trin | px | Tailwind | Typisk brug |
|---|---|---|---|
| 1 | 4 | `1` | ikon/tekst-mellemrum |
| 2 | 8 | `2` | chips-gab **[MOCKUP]**, label → felt |
| 3 | 12 | `3` | kategori-gab, ikon/tekst i tryghedsstribe **[MOCKUP]** |
| 4 | 16 | `4` | indre afstand i kort, mellem felter |
| 5 | 20 | `5` | kort-gab **[MOCKUP: 18 → rundet til 20]** |
| 6 | 24 | `6` | sidepadding tablet, mellem kortblokke |
| 8 | 32 | `8` | vandret sidepadding desktop **[MOCKUP]** |
| 10 | 40 | `10` | sektionspadding top **[MOCKUP]** |
| 14 | 56 | `14` | hero-panelets indre padding **[MOCKUP: 52 → rundet til 56]** |
| 16 | 64 | `16` | afstand mellem store sektioner på desktop |

Faste layout-regler:
- Sidebredde: `max-w-[1280px] mx-auto` **[MOCKUP]**
- Vandret sidepadding: `px-4` mobil, `px-6` tablet, `px-8` desktop **[desktop fra MOCKUP, resten FORSLAG]**
- Sektion: `py-8` mobil, `py-10` desktop **[MOCKUP + FORSLAG]**
- Hero-panel: `p-6` mobil, `p-14` desktop **[MOCKUP]**

---

## 5. Radier og skygger

| Klasse | Værdi | Bruges til |
|---|---|---|
| `rounded-md` | 8px | små elementer, søgeknappen inde i hero-søgefeltet **[MOCKUP]** |
| `rounded-lg` | 10px | knapper, ikonflader i tryghedsstribe **[MOCKUP]** |
| `rounded-xl` | 12px | inputfelter, søgeboks **[MOCKUP]** |
| `rounded-[14px]` | 14px | **kort og kategori-flader** **[MOCKUP]** |
| `rounded-[18px]` | 18px | hero-panel og andre store flader **[MOCKUP]** |
| `rounded-full` | 999px | chips, timer-badge, avatar, rund søgeknap i header **[MOCKUP]** |

Skygger – brug få og bløde:

| Navn | Værdi | Brug |
|---|---|---|
| skygge-kort | `0 1px 2px rgba(0,0,0,.04)` **[FORSLAG]** | auktionskort i hvile (kortet bæres af sin kant, ikke af skygge) |
| skygge-hover | `0 8px 24px rgba(0,0,0,.10)` **[FORSLAG, afledt af mockup]** | kort ved hover |
| skygge-flyder | `0 8px 30px rgba(0,0,0,.13)` **[MOCKUP]** | flydende bokse, dropdowns |
| skygge-stor | `0 10px 40px rgba(0,0,0,.13)` **[MOCKUP]** | modaler |

---

## 6. Knapper

Fælles: `font-sans font-semibold`, `rounded-lg` (10px) **[MOCKUP]**, tekst 14–15px,
`inline-flex items-center justify-center gap-2`, `transition-colors`.
Højder: **lille 36px** (kun desktop, sekundær), **normal 44px**, **stor 52px** (hero-CTA og alle primære
knapper på mobil). Vandret padding: `px-5` normal, `px-6` stor.

### 6.1 Primær (orange) – én pr. skærmområde
| Tilstand | Værdi |
|---|---|
| Normal | `bg-orange text-white` |
| Hover | `bg-orange-mork` |
| Fokus | `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen` |
| Aktiv (tryk) | `bg-orange-mork scale-[.99]` |
| Deaktiveret | `bg-orange/40 text-white/80 cursor-not-allowed`, ingen hover |
| Loading | 16px spinner til venstre for teksten, teksten bliver stående, `disabled` + `aria-busy="true"` |

### 6.2 Sekundær (kant)
| Tilstand | Værdi |
|---|---|
| Normal | `bg-white text-groen border border-groen` |
| Hover | `bg-groen-lys` |
| Fokus | som primær |
| Deaktiveret | `text-tekst-svag border-kant-staerk bg-white cursor-not-allowed` |
| Loading | som primær, spinner i `text-groen` |

### 6.3 På grøn flade (hero) **[MOCKUP – hvid knap på grøn]**
`bg-white text-groen`, hover `bg-groen-lys`, fokusring `outline-white`.

### 6.4 Tertiær / tekstknap
`text-groen font-medium`, hover `underline`. Til "Sådan virker det", "Se alle →". **[MOCKUP]**

### 6.5 Fare / destruktiv
Kun til: slet auktion, annullér handel, luk konto.

| Tilstand | Værdi |
|---|---|
| Normal | `bg-white text-fejl-tekst border border-fejl-kant` |
| Hover | `bg-fejl-bg` |
| Fyldt variant (bekræftelse i dialog) | `bg-[#A32020] text-white`, hover `bg-[#8A1A1A]` |
| Fokus | `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#A32020]` |
| Deaktiveret | `text-tekst-svag border-kant-staerk` |

Destruktive handlinger kræver altid en bekræftelsesdialog. **[FORSLAG]**

### 6.6 Loading-mønster
Knapper i formularer skal være `disabled` under indsendelse, så man ikke kan byde eller betale to gange.
Teksten skiftes ikke ud med "Vent…" – der vises en spinner ved siden af den eksisterende tekst, så knappen
ikke ændrer bredde.

---

## 7. Kort

### 7.1 Auktionskort **[MOCKUP]**
- Wrapper: `rounded-[14px] overflow-hidden border border-kant bg-white`
- Billede: 4:3 (mockup: 190px højt i et 4-spaltet grid på 1280px), `bg-skelet`,
  `next/image` med `fill` + korrekt `sizes`, lazy som standard
- Timer-badge: `absolute left-3 bottom-3 rounded-full px-[9px] py-[5px] text-xs font-semibold`,
  hvid flade + `text-tekst`; under 1 time: `bg-orange text-white`
- Krop: `px-[14px] pt-3 pb-4`
- Titel: 14px `text-tekst`, maks. 2 linjer (`line-clamp-2`)
- Pris: 18px/700, `mt-1.5`
- Meta ("14 bud"): 12px `text-tekst-svag`, `mt-0.5`
- Hover: skygge-hover + `border-kant-staerk`. Hele kortet er ét link med synlig `focus-visible`-ring
- Loading: samme geometri med `bg-skelet animate-pulse` i billede, titel og pris. Aldrig layoutspring

### 7.2 Kategorikort **[MOCKUP]**
`bg-groen-lys rounded-[14px] h-16 grid place-items-center`, ikon 24px i `text-groen-mork`, label 13px
under med `mt-2`. Hover: `bg-[#DCEAE4]` **[FORSLAG]**.

### 7.3 Info-/indholdskort (fx "Sådan virker det", kvitteringer)
`bg-white rounded-[14px] border border-kant p-6`. På en lys grøn sektion bruges i stedet `bg-white` uden kant,
eller `bg-groen-lys` på hvid sektion. Aldrig lys grøn på lys grøn.

### 7.4 Tryghedsstribe **[MOCKUP]**
`bg-groen-lys rounded-[14px]`; 4 kolonner desktop, 2 på tablet, 1 på mobil. Hver celle
`p-5 flex gap-3 items-center`, ikonflade `w-[38px] h-[38px] rounded-lg bg-white grid place-items-center`,
overskrift 15px/600 `text-groen-mork`, undertekst 14px.

### 7.5 Chips / tags **[MOCKUP]**
- På grøn flade: `bg-white/15 border border-white/25 text-white rounded-full px-3 py-1.5 text-[13px]`
- På hvid flade: `bg-groen-lys text-groen-mork rounded-full px-3 py-1.5 text-[13px]`
- Valgt tilstand: `bg-groen text-white` **[FORSLAG]**

---

## 8. Formularfelter

### 8.1 Label
14px `font-medium text-tekst`, `mb-1.5`. Altid en rigtig `<label htmlFor>` – pladsholdertekst er ikke en label.
Valgfrie felter markeres med " (valgfrit)" i `text-tekst-svag`; obligatoriske felter markeres ikke med
stjerne. **[FORSLAG]**

### 8.2 Tekstfelt / select / textarea
| Tilstand | Værdi |
|---|---|
| Normal | `h-11 w-full rounded-xl border border-kant-staerk bg-white px-4 text-[15px] text-tekst placeholder:text-pladsholder` |
| Hover | `border-[#BFBFBF]` |
| Fokus | `border-groen outline-2 outline-groen/25` |
| Fejl | `border-fejl-kant bg-fejl-bg/40` + `aria-invalid="true"` + `aria-describedby` til fejlteksten |
| Deaktiveret | `bg-[#F7F7F7] text-tekst-svag border-kant cursor-not-allowed` |
| Læs-kun | `bg-groen-lys border-transparent` |

Textarea: `min-h-[120px] py-3`. Select: samme ramme med chevron-ikon til højre.
Felthøjde på mobil må ikke gå under 44px.

### 8.3 Hjælpetekst og fejl
- Hjælpetekst: 13px `text-tekst-daempet`, `mt-1.5`.
- Fejltekst: 13px `text-fejl-tekst font-medium`, `mt-1.5`, med lille advarselsikon. Står **under** feltet.
- Formular-fejl øverst: `bg-fejl-bg border border-fejl-kant text-fejl-tekst rounded-xl p-4 text-sm`,
  `role="alert"`, og fokus flyttes dertil ved fejlet indsendelse.
- Selve fejlteksterne skrives af indhold-agenten. Frontend skriver korte pladsholdere og markerer dem som TODO.

### 8.4 Søgefelt **[MOCKUP]**
- Header: `rounded-full border-[1.5px] border-kant-staerk px-[18px] py-2.5 text-[15px]`, med rund orange
  knap yderst til højre (34px, `bg-orange text-white rounded-full`).
- Hero: `bg-white rounded-xl px-5 py-4` med orange "Søg"-knap i højre side (`rounded-md px-[18px]`).

### 8.5 Afkrydsning og radio
20px felt; `rounded-[6px]` for checkbox, `rounded-full` for radio, kant `--color-kant-staerk`.
Valgt: `bg-groen border-groen` med hvidt flueben. Hele rækken inkl. label er klikbar og mindst 44px høj.

### 8.6 Bud- og betalingsformular (særregel)
Før "Byd"-knappen vises altid en opsummering i `bg-groen-lys rounded-xl p-4`: bud, købergebyr og fragt
på hver sin linje i 14px `text-tekst-daempet`, og **totalprisen** nederst i 18px/700 med en tynd
skillelinje over. Knappen må ikke kunne trykkes, før totalen er beregnet og vist.

---

## 9. Øvrige mønstre

- **Header** **[MOCKUP]**: hvid, `px-8 py-4`, `border-b border-kant`; logo til venstre, søgefelt i midten
  (`flex-1`), "Log ind" (14px/500), "Sælg nu" som orange knap. Kategorilinje under:
  `px-8 py-3 text-sm text-[#444] gap-7 border-b border-kant`. På mobil: logo + søgeikon + burgermenu,
  og søgefeltet i fuld bredde under headeren.
- **Hero** **[MOCKUP]**: to spalter i `rounded-[18px] overflow-hidden mx-8 mt-6`; venstre `bg-groen`
  (flex 1.1) med hvid tekst, stort søgefelt, chips med populære søgninger og et sælgerlink; højre side
  billede (flex 1). Højde 460px på desktop. På mobil: stakket, billedet over panelet, panelhøjde efter
  indhold – ingen fast 460px.
- **Footer** **[FORSLAG]**: `bg-groen text-white py-14`, links `text-white/85`, hover hvid.
- **Sektionsoverskrift** **[MOCKUP]**: h2 med "Se alle →" som tekstlink i `text-groen` yderst til højre,
  14px/500, `items-baseline`.
- **Tom tilstand** **[FORSLAG]**: centreret; ikon i `bg-groen-lys rounded-full` 56px, h3, én linje i
  `text-tekst-daempet`, og en primær knap.
- **Loading** **[FORSLAG]**: skeletons der matcher det færdige layout (samme højder) – ikke en centreret
  spinner på en hel side. Hver route har `loading.tsx` og `error.tsx`.
- **Fejlside** **[FORSLAG]**: h2, kort forklaring, "Prøv igen" (sekundær knap) + "Til forsiden" (tekstlink).
- **Animation** **[FORSLAG]**: kun `transition-colors`, `opacity` og små `translate`, 150–200 ms, `ease-out`.
  Respektér `prefers-reduced-motion`.

---

## 10. Logo og ikoner

| Fil | Bruges til |
|---|---|
| `public/brand/bidhamr-logo.svg` | Header på web, footer, mails, delebilleder. Minimumsbredde 120px. Frizone omkring logoet: mindst logoets egen x-højde. |
| `public/brand/bidhamr-app-ikon.svg` | App-ikon, favicon, avatar-fallback, kvadratiske pladser. Bruges **aldrig** som logo med tekst ved siden af. |

Regler:
- Logoet må ikke strækkes, farves om, roteres eller lægges oven på et uroligt foto.
- På skovgrøn flade kræves en helt hvid logovariant. **Den findes ikke i dag – TODO til designeren**, sammen
  med tekst-til-kurver, favicon og PNG-størrelser til app stores (jf. beslutningerne afsnit 8).
- Ikonsæt: **Tabler Icons** **[MOCKUP – mockuppen bruger tabler-icons]**, `stroke-width 1.75`; 20px i tekst,
  24px i kategorier, 18px i ikonflader. Installeres som React-pakke, og der importeres kun de ikoner, der
  bruges – ingen webfont fra CDN.

---

## 11. Tilgængelighed

- **Kontrast**: brødtekst og ikoner, der bærer betydning, skal have mindst **4,5:1**. Store overskrifter
  (≥24px, eller ≥19px fed) mindst **3:1**.
  - Godkendt: hvid på `#1E5E4A`, `#154537` på `#E8F2EE`, `#1A1A1A` og `#555` på hvid, hvid på `#A32020`.
  - **Pas på:** hvid tekst på `#E8772E` giver kun ca. 3:1. Det er **kun** tilladt på knapper og badges med
    tekst på mindst 15px fed – aldrig til brødtekst eller små links. Orange tekst på hvid baggrund er forbudt;
    brug `#C75F1C` eller grøn.
  - `#777777` på hvid ligger lige på grænsen (4,5:1) – gå ikke lysere.
- **Fokus skal altid være synligt**:
  `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen`
  (hvid outline på grøn flade). Fjern aldrig `outline` uden at sætte noget i stedet.
- **Touch-mål: mindst 44×44px** på alt klikbart på mobil, med mindst 8px mellem to mål.
- Alt interaktivt skal kunne nås og aktiveres med tastatur. Ingen `div onClick` – brug `button`/`a`.
- Billeder har meningsfuld `alt`; rent dekorative har `alt=""`.
- Farve alene må ikke bære information: "slutter snart" har både orange farve **og** ur-ikon og tekst.
- Sprog: `<html lang="da">`.

---

## 12. Mobil først

Byg til 360px bredde først, læg derefter til. Brydepunkter = Tailwinds standard.

| Navn | Fra | Typisk ændring |
|---|---|---|
| (standard) | 0 | 1 spalte, `px-4`, hero stakket, kategorier 2×4, kort 1–2 pr. række |
| `sm` | 640px | kort 2 spalter, tryghedsstribe 2 spalter |
| `md` | 768px | `px-6`, kategorier 4 spalter, hero kan blive 2-spaltet |
| `lg` | 1024px | `px-8`, kort 3 spalter, tryghedsstribe 4 spalter, fuld header med søgefelt i midten |
| `xl` | 1280px | kort 4 spalter **[MOCKUP]**, kategorier 8 spalter **[MOCKUP]**, indhold centreret i `max-w-[1280px]` |

Faste mobilregler:
- Ingen vandret scroll. Test altid ved 360px.
- Primær CTA i fuld bredde (`w-full`, 52px høj).
- Bud-panelet på en auktionsside er fastgjort i bunden
  (`sticky bottom-0 bg-white border-t border-kant p-4`) og viser **totalprisen**. **[FORSLAG]**
- Skriftstørrelser går aldrig under mobilværdierne i afsnit 3.

---

## 13. Hvad Filip skal beslutte

1. Statusfarverne i 1.4 – især fejlfarven `#A32020` i stedet for den gamle `#E63946`.
2. `#C75F1C` som mørkere orange til hover/active.
3. At orange kun må bruges til store, fede knaptekster på grund af kontrast (afsnit 11).
4. Radier som standard: 14px på kort, 18px på store flader.
5. Hvid logovariant + favicon og PNG'er fra designer (afsnit 10).
6. Tabler Icons som officielt ikonsæt.
7. Sticky bud-panel i bunden på mobil.
8. Skalaen for mobil-typografi (afsnit 3) – mockuppen viser kun desktop.
