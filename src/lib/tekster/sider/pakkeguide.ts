// Tekster til /pakkeguide ("Sådan pakker du din vare").
// Bygger på ROADMAP-BESLUTNINGER.md afsnit 4 (Pakkebilleder, sælgerens ansvar,
// advarselssystem for dårlig indpakning) og "Sælger markerer selv pakken sendt"
// (6. okt. 2026).
//
// Fragtlabels i BidHamr er bag flaget FRAGT_LABELS_AKTIV og ikke aktive endnu.
// Siden må derfor IKKE love, at sælgeren får en label fra BidHamr.
// OPDATER, når fragtlabels er slået til: beskriv, hvor labelen hentes.
// Knap- og trinnavne følger UI: trinnet hedder "Send pakken", knappen
// "Marker som sendt" (src/components/HandelHandlinger.tsx).

import type { Tekstside } from "./typer";

export const PAKKEGUIDE: Tekstside = {
  titel: "Sådan pakker du din vare",
  metabeskrivelse:
    "Gode råd til at pakke din vare sikkert, når du sælger på BidHamr. Se, hvilke billeder du skal tage, og hvordan du pakker skrøbelige ting, elektronik, tøj og store ting.",
  intro:
    "Som sælger har du ansvaret for at pakke varen forsvarligt. En god indpakning er den bedste måde at undgå en ødelagt vare og en sag.",
  afsnit: [
    {
      id: "ansvar",
      overskrift: "Du har ansvaret for indpakningen",
      tekst: [
        "Varen skal kunne tåle at blive løftet, stablet og tabt på vejen. Pak den, så den ikke kan rykke sig i kassen, og så den kan klare et stød.",
        "Går en vare i stykker, og køberen har valgt BidHamr Beskyttelse, bruger vi dine pakkebilleder til at vurdere, om varen var pakket ordentligt.",
      ],
    },
    {
      id: "send-pakken",
      overskrift: "Sådan sender du pakken",
      trin: [
        {
          titel: "Pak varen",
          tekst: "Brug en solid kasse og fyld, så varen sidder fast. Følg rådene nedenfor.",
        },
        {
          titel: "Tag et billede af den åbne kasse",
          tekst:
            "Tag billedet ovenfra, så både varen og fyldet omkring den kan ses.",
        },
        {
          titel: "Luk kassen, og sæt labelen på",
          tekst: "Tape kassen godt til, og sæt fragtlabelen tydeligt på toppen.",
        },
        {
          titel: "Tag et billede af den lukkede kasse",
          tekst: "Hele kassen skal kunne ses, lukket og tapet, med labelen.",
        },
        {
          titel: "Aflever pakken, og marker den som sendt",
          tekst:
            "Gå til handlen under Mine handler. I trinnet \"Send pakken\" tager du de to billeder, skriver sporingsnummeret og trykker \"Marker som sendt\". Det skal du gøre selv, også når fragtfirmaet har registreret pakken.",
        },
      ],
      note: "Billederne tages med kameraet direkte på siden eller i appen – ikke fra din kamerarulle. Du skal markere pakken som sendt inden 5 dage efter, at køberen har betalt. Ellers annulleres handlen, og køberen får alle pengene tilbage.",
    },
    {
      id: "billeder",
      overskrift: "Hvorfor skal jeg tage billeder?",
      tekst: [
        "Billederne viser, hvordan du har pakket varen. De bruges, hvis der kommer en sag om en vare, der er gået i stykker undervejs.",
        "Billederne viser kun indpakningen. De beviser ikke, at varen blev i kassen.",
      ],
    },
    {
      id: "advarsler",
      overskrift: "Det er dit ansvar at pakke varen godt ind",
      punkter: [
        "Som sælger har du altid ansvaret for, at varen er pakket forsvarligt – så den kan tåle at blive løftet, stablet og rystet på vejen.",
        "Pakken bliver håndteret af mange hænder og maskiner, før den når frem. En god indpakning er den bedste måde at sikre, at køberen får varen hel.",
        "Går varen i stykker, fordi den var pakket dårligt, er det dit tab. Fragtfirmaer erstatter som regel ikke skader, der skyldes dårlig indpakning.",
        "Har køberen valgt BidHamr Beskyttelse, og har du pakket ordentligt, klager BidHamr til fragtfirmaet, hvis varen alligevel går i stykker på vejen. Dine pakkebilleder er beviset.",
        "Derfor skal du tage billeder af varen i den åbne kasse og af den lukkede kasse, når du sender pakken.",
        "Pakker du for dårligt, kan du få en påmindelse eller en advarsel. Begrundelsen kan du altid se på din konto.",
      ],
    },
    {
      id: "generelt",
      overskrift: "Gode råd til alle pakker",
      punkter: [
        "Brug en solid kasse, der er lidt større end varen. Genbrug gerne, hvis kassen er hel og stærk.",
        "Fyld tomrummet ud med bobleplast, avispapir eller pap, så varen ikke kan rykke sig.",
        "Der skal være fyld på alle sider – også i bunden og under låget.",
        "Ryst kassen forsigtigt, når den er lukket. Kan du mærke, at noget flytter sig, så fyld mere i.",
        "Tape alle samlinger, også i bunden.",
        "Fjern eller dæk gamle labels og stregkoder, så pakken ikke bliver sendt forkert.",
      ],
    },
    {
      id: "skroebeligt",
      overskrift: "Skrøbelige ting",
      tekst: ["Fx glas, porcelæn, keramik, spejle og billeder i rammer."],
      punkter: [
        "Pak hver ting ind for sig i flere lag bobleplast.",
        "Fyld hulrum ud, fx inde i kopper og vaser.",
        "Læg mindst 5 cm fyld mellem varen og kassens sider.",
        "Ved meget skrøbelige ting: brug to kasser – en lille inden i en større, med fyld imellem.",
        "Sæt pap foran glas i rammer og spejle.",
      ],
    },
    {
      id: "elektronik",
      overskrift: "Elektronik",
      tekst: ["Fx telefoner, computere, høretelefoner og spillekonsoller."],
      punkter: [
        "Brug den originale æske, hvis du har den, og læg den ned i en ydre kasse med fyld.",
        "Pak skærmen ind i bobleplast, og beskyt den mod tryk.",
        "Pak ledninger og opladere for sig, så de ikke ridser varen.",
        "Sluk enheden helt, før du pakker den.",
      ],
    },
    {
      id: "toej",
      overskrift: "Tøj, sko og tasker",
      punkter: [
        "Fold tøjet pænt, og læg det i en plastpose, så det er beskyttet mod vand.",
        "En solid pose eller en lille kasse er fint til tøj. Sko og tasker sendes bedst i kasse, så de ikke bliver mast.",
        "Fyld sko og tasker med papir, så de holder formen.",
      ],
    },
    {
      id: "store-ting",
      overskrift: "Store og tunge ting",
      tekst: ["Fx møbler, lamper og værktøj."],
      punkter: [
        "Tjek fragtfirmaets krav til størrelse og vægt, før du sætter auktionen op. Er varen for stor til en almindelig pakke, så vælg afhentning.",
        "Skil gerne varen ad, og pak skruer og små dele i en lukket pose, der tapes fast inde i kassen.",
        "Beskyt hjørner og kanter med pap eller hjørnebeskyttere.",
        "Tunge ting skal ligge i bunden og sidde helt fast.",
      ],
    },
  ],
};
