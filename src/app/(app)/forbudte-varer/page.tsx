import type { Metadata } from "next";
import Tekstside from "@/components/Tekstside";
import type { Tekstside as TekstsideData } from "@/lib/tekster/sider/typer";
import { FORBUDTE_KATEGORIER } from "@/lib/forbudteVarer";

// Listen kommer fra src/lib/forbudteVarer.ts (samme liste som
// public.forbudte_varer() i databasen og appen).
const SIDE: TekstsideData = {
  titel: "Forbudte varer",
  metabeskrivelse:
    "Se, hvilke varer du ikke må sælge på BidHamr – fx våben, narkotika, medicin, levende dyr, kopivarer og stjålne varer.",
  intro:
    "Nogle varer må ikke sælges på BidHamr, fordi de er ulovlige, farlige eller kræver særlig tilladelse. Listen gælder alle auktioner – også varer, du selv har lavet eller arvet.",
  afsnit: [
    ...FORBUDTE_KATEGORIER.map((k) => ({
      id: k.kode.replace(/_/g, "-"),
      overskrift: k.navn,
      tekst: [k.beskrivelse],
    })),
    {
      id: "hvad-sker-der",
      overskrift: "Hvad sker der, hvis en vare er forbudt?",
      punkter: [
        "Når du opretter en auktion, bekræfter du, at varen ikke er forbudt.",
        "Står der åbenlyst forbudte ord i titlen eller beskrivelsen, kan auktionen ikke oprettes.",
        "Er vi i tvivl, bliver auktionen oprettet, men en medarbejder hos BidHamr kigger på den.",
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
