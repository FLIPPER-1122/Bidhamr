// Tekster til /cookies.
// Skrevet ud fra det, koden faktisk bruger (gennemgået 6. okt. 2026):
// - Supabase-login: cookies "sb-<projekt>-auth-token" (kan deles i .0, .1 …),
//   sat af @supabase/ssr i src/lib/supabase/{server,middleware,client}.ts.
//   Standard-levetid i @supabase/ssr: 400 dage. Ved signup og "glemt
//   adgangskode" sætter Supabase også "sb-<projekt>-auth-token-code-verifier"
//   (PKCE), som fjernes, når linket i mailen er brugt.
// - bh_enhed (src/lib/enheder.ts): tilfældig værdi, kun hash gemmes. Sættes
//   ved login og bruges til "Nyt login"-mailen (sikkerhed). 400 dage.
// - bh_tjek_email (src/lib/tilmelding.ts, src/app/actions/auth.ts): mailen
//   efter signup til "Tjek din indbakke". 24 timer, httpOnly.
// - bh_samtykke (src/lib/samtykke.ts): cookievalget. 12 måneder.
// - Stripe: Stripe.js indlæses først, når man åbner betalingen eller trykker
//   "Gem et kort" (src/lib/stripeKlient.ts). Stripe sætter __stripe_mid og
//   __stripe_sid til svindelforebyggelse og kan sætte cookies på egne
//   domæner (fx m.stripe.network) i betalingsvinduet, også via Google Pay/
//   Apple Pay. TJEK navne og varighed på Stripes side før lancering.
// - localStorage: kladde til "Opret auktion" (src/components/OpretAuktionForm.tsx)
//   og en foldet menu i medarbejderpanelet (src/components/admin/AdminSidebar.tsx).
//   Ingen sessionStorage.
// - Ingen statistik-, reklame- eller sporingscookies. Skrifttyper hostes selv
//   via next/font (ingen kald til Google). Billeder hentes gennem BidHamrs
//   eget domæne (next/image).
// - Besøgsstatistik: egen, cookiefri (src/components/statistik/Sidevisning.tsx
//   -> /api/statistik -> tabellen sidevisninger). Gemmer kun antal pr. dag og
//   sidetype (id'er fjernet). Ingen cookies, intet bruger-id, ingen IP, ingen
//   tredjepart. Respekterer Do Not Track og Global Privacy Control.
//
// OPDATER denne side OG tæl SAMTYKKE_VERSION op i src/lib/samtykke.ts, hvis
// der tilføjes tredjepart: statistik, kort, video, chat-widgets, sociale
// knapper, reklame eller andet, der sætter cookies eller læser fra browseren.
// Sådanne værktøjer må kun indlæses via src/lib/samtykkeKlient.ts.
// TODO indhold-agenten: gennemlæs teksterne.

import type { Tekstside } from "./typer";

const KOLONNER = ["Navn", "Formål", "Udbyder", "Varighed", "Kategori"];

export const COOKIES: Tekstside = {
  titel: "Cookies",
  metabeskrivelse:
    "Se, hvilke cookies BidHamr bruger, og skift dine cookieindstillinger. Vi bruger kun det, der er nødvendigt for login, sikkerhed og betaling.",
  intro:
    "En cookie er en lille fil, som en hjemmeside gemmer i din browser. BidHamr bruger kun de cookies, der er nødvendige for, at siden virker. Vi bruger ikke cookies til statistik, reklame eller til at følge dig rundt på nettet.",
  senestOpdateret: "6. oktober 2026",
  afsnit: [
    {
      id: "dit-valg",
      overskrift: "Dit cookievalg",
      tekst: [
        "Første gang du besøger BidHamr, spørger vi, hvad du vil tillade. Nødvendige cookies er altid til. Statistik og markedsføring er slået fra, til du selv siger ja – og vi bruger dem ikke i dag.",
        "Du kan altid ændre dit valg eller trække dit samtykke tilbage. Det er lige så nemt som at give det: tryk på \"Cookieindstillinger\" her eller nederst på siden. Vi spørger dig igen efter 12 måneder, eller hvis vi ændrer, hvilke cookies vi bruger.",
      ],
    },
    {
      id: "noedvendige",
      overskrift: "Nødvendige cookies",
      tekst: [
        "Disse cookies skal til, for at du kan logge ind, holde din konto sikker og betale. Derfor kræver de ikke dit samtykke, og de kan ikke slås fra på BidHamr.",
      ],
      tabel: {
        titel: "Nødvendige cookies på BidHamr",
        kolonner: KOLONNER,
        raekker: [
          [
            "sb-…-auth-token",
            "Holder dig logget ind. Kan være delt op i flere dele (.0, .1).",
            "BidHamr (via Supabase)",
            "Til du logger ud, højst 400 dage",
            "Nødvendig",
          ],
          [
            "sb-…-auth-token-code-verifier",
            "Sikrer linket i mailen, når du opretter en konto eller nulstiller din adgangskode.",
            "BidHamr (via Supabase)",
            "Til linket er brugt",
            "Nødvendig",
          ],
          [
            "bh_enhed",
            "Genkender din browser, så vi kan give dig besked, hvis nogen logger ind på din konto fra en ny enhed. Hos os gemmes kun en sløret kode (hash), ikke selve værdien.",
            "BidHamr",
            "400 dage",
            "Nødvendig",
          ],
          [
            "bh_tjek_email",
            "Husker din e-mail, mens du venter på mailen, der bekræfter din konto.",
            "BidHamr",
            "24 timer",
            "Nødvendig",
          ],
          [
            "bh_samtykke",
            "Husker dit cookievalg, så vi ikke spørger hver gang.",
            "BidHamr",
            "12 måneder",
            "Nødvendig",
          ],
          [
            "__stripe_mid",
            "Forebygger svindel, når du betaler eller gemmer et kort. Sættes først, når du åbner betalingen.",
            "Stripe",
            "1 år",
            "Nødvendig",
          ],
          [
            "__stripe_sid",
            "Forebygger svindel under selve betalingen.",
            "Stripe",
            "30 minutter",
            "Nødvendig",
          ],
        ],
      },
      note: "I betalingsvinduet kan Stripe – og Google Pay eller Apple Pay, hvis du bruger dem – sætte egne cookies for at gennemføre betalingen sikkert. De bruges kun dér.",
      links: [{ tekst: "Stripes oplysninger om cookies", href: "https://stripe.com/legal/cookies-policy" }],
    },
    {
      id: "lokal-lagring",
      overskrift: "Lagring i din browser",
      tekst: [
        "Et par steder gemmer vi små ting direkte i din browser (\"local storage\"). Det bliver på din egen enhed og sendes ikke til os.",
      ],
      tabel: {
        titel: "Lagring i browseren på BidHamr",
        kolonner: KOLONNER,
        raekker: [
          [
            "bidhamr:opret-kladde:…",
            "Gemmer din kladde, mens du opretter en auktion, så du ikke mister den.",
            "BidHamr",
            "Til auktionen er oprettet, eller du sletter kladden",
            "Nødvendig",
          ],
          [
            "bidhamr-admin-indstillinger-aaben",
            "Husker, om en menu er foldet ud. Kun for BidHamrs medarbejdere.",
            "BidHamr",
            "Til du sletter den i browseren",
            "Nødvendig",
          ],
        ],
      },
    },
    {
      id: "statistik",
      overskrift: "Statistik",
      tekst: [
        "Vi bruger ikke cookies til besøgsstatistik. Vores statistik er cookiefri og bygget af os selv – der er ingen tredjepart som fx Google Analytics.",
        "Når du åbner en side, tæller vi den op med én. Vi gemmer kun, hvilken slags side det var (fx \"en auktion\"), og hvilken dag. Vi gemmer ikke, hvem du er, din IP-adresse, hvilken auktion du så, eller hvad du søgte efter, og vi kan ikke følge dig fra side til side.",
        "Har du slået \"Do Not Track\" eller \"Global Privacy Control\" til i din browser, tæller vi slet ikke dit besøg.",
      ],
    },
    {
      id: "markedsfoering",
      overskrift: "Markedsføring",
      tekst: [
        "Vi bruger ingen reklamecookies og ingen cookies, der følger dig på andre hjemmesider.",
      ],
    },
    {
      id: "slet",
      overskrift: "Sådan sletter du cookies",
      tekst: [
        "Du kan altid slette cookies i din browsers indstillinger. Sletter du login-cookien, bliver du logget ud og skal logge ind igen. Sletter du bh_samtykke, spørger vi dig om dit cookievalg igen.",
      ],
    },
    {
      id: "aendringer",
      overskrift: "Ændringer",
      tekst: [
        "Begynder vi at bruge nye cookies, opdaterer vi denne side. Kræver de dit samtykke, spørger vi dig, før de bliver sat.",
      ],
    },
  ],
};
