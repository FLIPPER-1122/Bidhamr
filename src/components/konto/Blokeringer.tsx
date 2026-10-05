import Link from "next/link";
import type { Blokering } from "@/app/actions/kontoSletning";

// Hvad der forhindrer sletning af kontoen, med link til hvor det løses.
// Typerne kommer fra konto_sletning_blokeringer() i databasen.
const TYPE: Record<string, { titel: string; hjaelp: string }> = {
  staff: {
    titel: "Du er medarbejder hos BidHamr",
    hjaelp: "En chef skal fjerne din medarbejderrolle, før kontoen kan slettes.",
  },
  auktion_med_bud: {
    titel: "Auktion i gang med bud",
    hjaelp: "Bud er bindende, så auktionen skal slutte, og handlen gøres færdig.",
  },
  bud_paa_aktiv: {
    titel: "Du har budt på en auktion, der stadig er i gang",
    hjaelp: "Dit bud er bindende. Vent, til auktionen er slut.",
  },
  mangler_betaling: {
    titel: "Du mangler at betale",
    hjaelp: "Betal for varen, eller vent til handlen er annulleret.",
  },
  aaben_handel: {
    titel: "Handel i gang",
    hjaelp: "Handlen skal være afsluttet eller annulleret.",
  },
  aaben_sag: {
    titel: "Sag i gang",
    hjaelp: "Sagen skal være afgjort, og pengene flyttet.",
  },
  aaben_anke: {
    titel: "Anke venter på svar",
    hjaelp: "BidHamr skal afgøre anken først.",
  },
  aabent_tilbud: {
    titel: "Tilbud venter på svar",
    hjaelp: "Svar på tilbuddet, eller vent til det udløber.",
  },
  penge_undervejs: {
    titel: "Penge er på vej",
    hjaelp: "En betaling, udbetaling eller tilbagebetaling er ikke færdig endnu.",
  },
  ubetalt_sag: {
    titel: "Sag om manglende betaling",
    hjaelp: "BidHamr skal behandle sagen først.",
  },
};

export default function Blokeringer({ blokeringer }: { blokeringer: Blokering[] }) {
  return (
    <ul className="space-y-3">
      {blokeringer.slice(0, 50).map((b, i) => {
        const t = TYPE[b.type] ?? { titel: "Noget er i gang", hjaelp: "Skriv til support@bidhamr.dk, hvis du er i tvivl." };
        return (
          <li key={`${b.type}-${b.link ?? i}`} className="rounded-xl border border-advarsel-kant bg-white p-4">
            <p className="text-[15px] font-semibold text-tekst">{t.titel}</p>
            {b.type !== "staff" && <p className="mt-0.5 text-sm text-tekst">{b.tekst}</p>}
            <p className="mt-1 text-[13px] text-tekst-daempet">{t.hjaelp}</p>
            {b.link && (
              <Link href={b.link} className="btn btn-sekundaer btn-lille mt-3 w-full sm:w-auto">
                Gå til {b.type.startsWith("auktion") || b.type === "bud_paa_aktiv" ? "auktionen" : b.type === "aabent_tilbud" ? "tilbuddet" : "handlen"}
              </Link>
            )}
          </li>
        );
      })}
      {blokeringer.length > 50 && (
        <li className="text-sm text-tekst-daempet">… og {blokeringer.length - 50} mere.</li>
      )}
    </ul>
  );
}
