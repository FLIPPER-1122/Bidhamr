import type { Metadata } from "next";
import Link from "next/link";
import Ikon, { type IkonNavn } from "@/components/Ikon";
import { DSA_KONTAKT_EMAIL } from "@/lib/dsa/regler";

// Kontaktpunkt og forklaring efter EU's forordning om digitale tjenester
// (DSA art. 11, 12, 16, 17 og 20). Teksten er foreslået af Claude og skal
// gennemgås af advokat (se ROADMAP-BESLUTNINGER.md, afsnit "DSA").
// TODO indhold: gennemgå de korte tekster i de tre handlingskort.

export const metadata: Metadata = {
  title: "Ulovligt indhold og DSA",
  description:
    "Sådan anmelder du ulovligt indhold på BidHamr, sådan følger du din anmeldelse, og sådan klager du over en afgørelse.",
};

const h2 = "font-serif text-[20px] leading-tight font-semibold text-tekst sm:text-[22px]";
const p = "mt-2 text-[15px] leading-relaxed text-tekst-daempet";
const kort = "rounded-[14px] border border-kant bg-white p-5 sm:p-6";

type Handling = {
  id: string;
  ikon: IkonNavn;
  titel: string;
  tekst: React.ReactNode;
  knap: string;
  href: string;
  primaer?: boolean;
};

const HANDLINGER: Handling[] = [
  {
    id: "anmeld",
    ikon: "skjold",
    titel: "Anmeld indhold",
    tekst: "Har du set noget ulovligt eller noget, der bryder vores regler? Du behøver ikke en konto.",
    knap: "Anmeld indhold",
    href: "/dsa/anmeld",
    primaer: true,
  },
  {
    id: "foelg",
    ikon: "ur",
    titel: "Følg min anmeldelse",
    tekst: "Linket til din anmeldelse står i kvitteringen, vi sendte på e-mail. Er du logget ind, kan du også se den under Min konto.",
    knap: "Se mine anmeldelser",
    href: "/konto/afgoerelser",
  },
  {
    id: "klag",
    ikon: "besked",
    titel: "Klag over en afgørelse",
    tekst: "Linket til at klage står i e-mailen med vores afgørelse og under Min konto → Afgørelser. Det er gratis.",
    knap: "Se mine afgørelser",
    href: "/konto/afgoerelser",
  },
];

export default function DsaSide() {
  return (
    <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <div className="max-w-3xl">
        <h1 className="font-serif text-[26px] leading-tight font-semibold text-tekst sm:text-[32px]">
          Ulovligt indhold og dine rettigheder
        </h1>
        <p className="mt-2 text-base text-tekst-daempet">
          Her kan du anmelde indhold, følge din sag og klage over vores afgørelser. Vi følger EU&apos;s forordning om
          digitale tjenester (DSA).
        </p>
      </div>

      <ul className="mt-6 grid gap-4 md:grid-cols-3" aria-label="Hvad vil du gøre?">
        {HANDLINGER.map((h) => (
          <li key={h.id} className="flex flex-col rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <span className="grid h-[38px] w-[38px] place-items-center rounded-lg bg-groen-lys text-groen-mork">
              <Ikon navn={h.ikon} className="h-[18px] w-[18px]" />
            </span>
            <h2 id={`handling-${h.id}`} className="mt-3 font-serif text-[18px] leading-tight font-semibold text-tekst">
              {h.titel}
            </h2>
            <p className="mt-1.5 flex-1 text-sm leading-relaxed text-tekst-daempet">{h.tekst}</p>
            <Link
              href={h.href}
              className={`btn mt-4 w-full ${h.primaer ? "btn-primaer" : "btn-sekundaer"}`}
            >
              {h.knap}
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-10 grid max-w-3xl gap-4">
        <section className={kort} aria-labelledby="behandling">
          <h2 id="behandling" className={h2}>Sådan behandler vi en anmeldelse</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-tekst-daempet">
            <li>Du får en kvittering med et sagsnummer på e-mail.</li>
            <li>En medarbejder ser på sagen. Vi afgør aldrig noget alene med automatik.</li>
            <li>Vi svarer som regel inden for 7 dage – inden for 24 timer ved misbrug af børn og hadefuld tale.</li>
            <li>Den, du anmelder, får aldrig at vide, hvem du er.</li>
            <li>Er der fare for liv eller sikkerhed, giver vi politiet besked.</li>
          </ul>
        </section>

        <section className={kort} aria-labelledby="fjernet">
          <h2 id="fjernet" className={h2}>Hvis vi fjerner noget, du har lagt op</h2>
          <p className={p}>
            Du får altid en begrundelse på e-mail: hvad vi har gjort, hvilken regel eller lov det bygger på, og hvordan
            du klager.
          </p>
        </section>

        <section className={kort} aria-labelledby="klage">
          <h2 id="klage" className={h2}>Sådan klager du</h2>
          <p className={p}>
            Du kan klage gratis inden for 6 måneder – også hvis du har anmeldt noget, og vi valgte ikke at gribe ind. En
            anden medarbejder end den, der traf afgørelsen, behandler klagen, og du får et begrundet svar.
          </p>
          <p className={p}>
            Er du stadig uenig, kan du gå til et godkendt udenretligt tvistbilæggelsesorgan (DSA artikel 21) eller til
            domstolene.
          </p>
        </section>

        <section className={kort} aria-labelledby="kontaktpunkt">
          <h2 id="kontaktpunkt" className={h2}>Kontaktpunkt for myndigheder og brugere</h2>
          <p className={p}>
            Myndigheder, Europa-Kommissionen, Det Europæiske Råd for Digitale Tjenester og brugere kan skrive til os på
            dansk eller engelsk:
          </p>
          <p className="mt-3 text-[15px] text-tekst">
            {/* TODO Filip: opret postkassen, og tilføj firmanavn, adresse og CVR, når de er på plads. */}
            <a href={`mailto:${DSA_KONTAKT_EMAIL}`} className="font-semibold text-groen hover:underline">
              {DSA_KONTAKT_EMAIL}
            </a>
          </p>
        </section>

        <section className={kort} aria-labelledby="rapport">
          <h2 id="rapport" className={h2}>Gennemsigtighed</h2>
          <p className={p}>Vi offentliggør hvert år en rapport med antal anmeldelser, indgreb, klager og suspenderinger.</p>
        </section>
      </div>
    </main>
  );
}
