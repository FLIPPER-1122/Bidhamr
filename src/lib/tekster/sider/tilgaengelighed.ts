// Tekster til /tilgaengelighed (tilgængelighedserklæring).
// Bygget som en almindelig dansk erklæring. BidHamr er en privat virksomhed,
// så der står ikke noget om Digitaliseringsstyrelsens klageadgang (den gælder
// offentlige myndigheder).
// Linket til /kontakt?emne=fejl forudsætter kontaktformularen (ROADMAP fase 3).
// Indtil den findes, kan brugeren skrive til support@bidhamr.dk.
// OPDATER "Senest opdateret" og "Kendte begrænsninger", hver gang siden er
// gennemgået, og når fase 3 (nyt design på alle sider) er færdig.

import type { Tekstside } from "./typer";

export const TILGAENGELIGHED: Tekstside = {
  titel: "Tilgængelighedserklæring",
  metabeskrivelse:
    "Se, hvordan vi arbejder for, at alle kan bruge bidhamr.dk, hvad der ikke virker godt nok endnu, og hvordan du melder en fejl.",
  intro:
    "Vi vil gerne have, at alle kan bruge bidhamr.dk – også hvis du bruger skærmlæser, tastatur, forstørrelse eller andre hjælpemidler. Her kan du se, hvor langt vi er.",
  senestOpdateret: "5. oktober 2026",
  afsnit: [
    {
      id: "maal",
      overskrift: "Vores mål",
      tekst: [
        "Vi arbejder efter WCAG 2.1 på niveau AA. Det er den internationale standard for tilgængelige hjemmesider.",
        "Erklæringen gælder hjemmesiden bidhamr.dk.",
      ],
    },
    {
      id: "status",
      overskrift: "Status",
      tekst: [
        "Hjemmesiden overholder delvist WCAG 2.1 AA. Vi er i gang med at bygge siden om, og nogle dele lever endnu ikke op til målet. De står nedenfor.",
      ],
    },
    {
      id: "det-goer-vi",
      overskrift: "Det gør vi",
      tekst: ["På de sider, der er bygget om til det nye design:"],
      punkter: [
        "Tekst og knapper har tydelig kontrast til baggrunden.",
        "Du kan bruge siden med tastaturet, og du kan altid se, hvor du er på siden.",
        "Knapper og links er store nok til at ramme på en mobil.",
        "Formularer har rigtige feltnavne, og fejl bliver forklaret i tekst – ikke kun med farve.",
        "Siden virker på mobil, tablet og computer.",
      ],
    },
    {
      id: "begraensninger",
      overskrift: "Kendte begrænsninger",
      punkter: [
        "Ikke alle sider er bygget om til det nye design endnu. På de ældre sider kan kontrast, overskrifter og fokus være mangelfulde.",
        "Billeder på auktioner bliver lagt op af sælgerne. De har ikke altid en beskrivelse, der fortæller, hvad billedet viser.",
        "Betalingsvinduet kommer fra vores betalingspartner Stripe. Vi kan ikke selv ændre det.",
        "En auktion slutter på et fast tidspunkt, og tiden kan ikke forlænges. Det er en del af, hvordan en auktion virker.",
      ],
    },
    {
      id: "vurdering",
      overskrift: "Sådan har vi vurderet siden",
      tekst: [
        "Vi har selv gennemgået siden. Den er endnu ikke testet af en uafhængig ekspert.",
      ],
    },
    {
      id: "fejl",
      overskrift: "Mangler der noget?",
      tekst: [
        "Har du svært ved at bruge en del af siden, vil vi gerne høre fra dig. Fortæl os, hvilken side det drejer sig om, og hvad der ikke virkede. Så forsøger vi at rette det – og hjælper dig med det, du skulle i mellemtiden.",
        "Du kan også skrive til support@bidhamr.dk.",
      ],
      links: [{ tekst: "Meld en fejl", href: "/kontakt?emne=fejl" }],
    },
  ],
};
