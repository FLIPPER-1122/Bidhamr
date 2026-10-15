import type { Metadata } from "next";
import Tekstside from "@/components/Tekstside";
import type { Tekstside as TekstsideData } from "@/lib/tekster/sider/typer";
import { FORBUDTE_KATEGORIER } from "@/lib/forbudteVarer";

// Listen kommer fra src/lib/forbudteVarer.ts (samme liste som
// public.forbudte_varer() i databasen og appen).
const SIDE: TekstsideData = {
  titel: "Forbudte varer",
  metabeskrivelse:
    "Se, hvilke varer du ikke må sælge på BidHamr – fx våben, narkotika, medicin, levende dyr, kopivarer, stjålne varer og kunst.",
  intro:
    "Nogle varer må ikke sælges på BidHamr, fordi de er ulovlige, farlige eller kræver særlig tilladelse. Listen gælder alle auktioner – også varer, du selv har lavet eller arvet.",
  afsnit: [
    ...FORBUDTE_KATEGORIER.map((k) => ({
      id: k.kode.replace(/_/g, "-"),
      overskrift: k.navn,
      tekst: [k.beskrivelse],
    })),
    {
      id: "kunst-eller-plakat",
      overskrift: "Kunst eller plakat?",
      tekst: [
        "Kunst er fx et maleri, en tegning, en akvarel, en skulptur, en buste, en bronzefigur, en litografi, en serigrafi, en radering, et træsnit eller et andet grafisk tryk – også når det er signeret og nummereret, og også når du selv har lavet det.",
        "En plakat eller et billede, der er masseproduceret og ikke har en kunstner eller en særlig værdi – fx et billede på lærred fra IKEA – er ikke kunst og må gerne sælges.",
        "Står der kunst-ord i titlen eller beskrivelsen, spørger vi, om varen er kunst. Er den ikke, bekræfter du det, og auktionen bliver oprettet. En medarbejder kigger på den, og er det kunst, bliver den fjernet.",
      ],
    },
    {
      id: "hvad-sker-der",
      overskrift: "Hvad sker der, hvis en vare er forbudt?",
      punkter: [
        "Når du opretter en auktion, bekræfter du, at varen ikke er forbudt.",
        "Ulovlige varer kan ikke sættes til salg. Står der fx skydevåben, narkotika, falske mærkevarer eller levende dyr i titlen eller beskrivelsen, kan auktionen ikke oprettes.",
        "Enkelte lovlige varer – fx billetter, alkohol og tobak – bliver kontrolleret af BidHamr. Auktionen bliver oprettet, men en medarbejder kigger på den.",
        "Ligner varen kunst, bliver auktionen også kontrolleret af en medarbejder. Kunst bliver fjernet.",
        "Forbudte varer bliver fjernet. Gentagne overtrædelser kan give en advarsel og i sidste ende lukning af kontoen.",
      ],
    },
    {
      id: "i-tvivl",
      overskrift: "Er du i tvivl?",
      tekst: [
        "Listen er ikke udtømmende: Alt, der er ulovligt at sælge i Danmark, er også forbudt på BidHamr. Er du i tvivl, så skriv til os, før du sætter varen til salg.",
      ],
      links: [{ tekst: "Kontakt kundeservice", href: "/kontakt" }],
    },
  ],
};

export const metadata: Metadata = {
  title: SIDE.titel,
  description: SIDE.metabeskrivelse,
};

export default function ForbudteVarerPage() {
  return <Tekstside side={SIDE} />;
}
