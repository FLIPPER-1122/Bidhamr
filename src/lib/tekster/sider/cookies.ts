// Tekster til /cookies.
// Skrevet ud fra det, koden faktisk bruger (gennemgået 5. okt. 2026):
// - Supabase-login: cookies "sb-<projekt>-auth-token" (kan deles i .0, .1 …),
//   sat af @supabase/ssr i src/lib/supabase/{server,middleware}.ts.
//   Standard-levetid i @supabase/ssr: 400 dage.
// - Stripe: Stripe.js indlæses kun på betalingssider (src/lib/stripeKlient.ts,
//   src/components/betaling/*). Stripe kan sætte egne cookies til svindel-
//   forebyggelse. Navnene står på Stripes egen side – tjek dem, før lancering.
// - localStorage: kun til at huske, om en menu er foldet ud
//   (src/components/admin/AdminSidebar.tsx, kun for medarbejdere).
// - Ingen statistik-, reklame- eller sporingscookies. Skrifttyper hostes selv
//   via next/font (ingen kald til Google).
//
// OPDATER denne side, hvis der tilføjes tredjepart: statistik, kort, video,
// chat-widgets, sociale knapper, reklame eller andet, der sætter cookies eller
// læser fra browseren. Så skal der måske også et samtykke-banner til.
// OPDATER afsnittet "Besøgsstatistik", når statistikken er valgt og bygget.

import type { Tekstside } from "./typer";

export const COOKIES: Tekstside = {
  titel: "Cookies",
  metabeskrivelse:
    "Se, hvilke cookies BidHamr bruger. Vi bruger kun det, der er nødvendigt for, at du kan logge ind og betale.",
  intro:
    "En cookie er en lille fil, som en hjemmeside gemmer i din browser. BidHamr bruger kun de cookies, der er nødvendige for, at siden virker. Vi bruger ikke cookies til reklame eller til at følge dig rundt på nettet.",
  senestOpdateret: "5. oktober 2026",
  afsnit: [
    {
      id: "noedvendige",
      overskrift: "Nødvendige cookies",
      tekst: [
        "Disse cookies skal til, for at siden virker. De kan ikke slås fra på BidHamr.",
      ],
      punkter: [
        "Login: Når du logger ind, gemmer vi en cookie, der husker, at det er dig. Den hedder \"sb-…-auth-token\" og kommer fra vores leverandør Supabase. Den slettes, når du logger ud, og ellers senest efter 400 dage.",
        "Betaling: Når du betaler eller gemmer et kort, viser vi betalingsvinduet fra vores betalingspartner Stripe. Stripe kan sætte sine egne cookies for at gennemføre betalingen og forhindre svindel. De bruges kun på betalingssiderne.",
      ],
      links: [{ tekst: "Stripes oplysninger om cookies", href: "https://stripe.com/legal/cookies-policy" }],
    },
    {
      id: "lokal-lagring",
      overskrift: "Indstillinger i din browser",
      tekst: [
        "Nogle steder husker vi små valg i din browser, fx om en menu er foldet ud. Det gemmes kun på din egen enhed og sendes ikke til os.",
      ],
    },
    {
      id: "statistik",
      overskrift: "Besøgsstatistik",
      tekst: [
        "Vi bruger ikke cookies til besøgsstatistik. Måler vi, hvor mange der besøger siden, sker det uden cookies og uden at kunne se, hvem du er.",
      ],
    },
    {
      id: "reklame",
      overskrift: "Reklame og sporing",
      tekst: [
        "Vi bruger ingen reklamecookies og ingen cookies, der følger dig på andre hjemmesider.",
      ],
    },
    {
      id: "slet",
      overskrift: "Sådan sletter du cookies",
      tekst: [
        "Du kan altid slette cookies i din browsers indstillinger. Sletter du login-cookien, bliver du logget ud og skal logge ind igen.",
      ],
    },
    {
      id: "aendringer",
      overskrift: "Ændringer",
      tekst: [
        "Begynder vi at bruge nye cookies, opdaterer vi denne side.",
      ],
    },
  ],
};
