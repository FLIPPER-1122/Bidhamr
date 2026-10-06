import type { Metadata } from "next";
import Link from "next/link";
import { DSA_KONTAKT_EMAIL } from "@/lib/dsa/regler";

// Kontaktpunkt og forklaring efter EU's forordning om digitale tjenester
// (DSA art. 11, 12, 16, 17 og 20). Teksten er foreslået af Claude og skal
// gennemgås af advokat (se ROADMAP-BESLUTNINGER.md, afsnit "DSA").

export const metadata: Metadata = {
  title: "Ulovligt indhold og DSA",
  description:
    "Sådan anmelder du ulovligt indhold på BidHamr, sådan behandler vi anmeldelser, og sådan klager du over en afgørelse.",
};

const h2 = "font-serif text-[20px] leading-tight font-semibold text-tekst sm:text-[22px]";
const p = "mt-2 text-[15px] leading-relaxed text-tekst-daempet";
const kort = "rounded-[14px] border border-kant bg-white p-5 sm:p-6";

export default function DsaSide() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:py-12">
      <h1 className="font-serif text-[26px] leading-tight font-semibold text-tekst sm:text-[32px]">
        Ulovligt indhold og dine rettigheder
      </h1>
      <p className="mt-2 text-base text-tekst-daempet">
        BidHamr følger EU&apos;s forordning om digitale tjenester (Digital Services Act, DSA). Her kan du se, hvordan du
        anmelder noget, hvordan vi behandler det, og hvordan du klager, hvis vi har grebet ind over for dit indhold.
      </p>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Link href="/dsa/anmeld" className="btn btn-primaer">
          Anmeld ulovligt indhold
        </Link>
        <a href={`mailto:${DSA_KONTAKT_EMAIL}`} className="btn btn-sekundaer">
          Skriv til vores kontaktpunkt
        </a>
      </div>

      <div className="mt-8 flex flex-col gap-4">
        <section className={kort} aria-labelledby="anmeld">
          <h2 id="anmeld" className={h2}>Anmeld ulovligt indhold</h2>
          <p className={p}>
            Ser du en auktion, en profil, et spørgsmål eller en bedømmelse, som du mener er ulovlig eller bryder vores
            regler, så tryk på <strong className="font-semibold text-tekst">Anmeld</strong> ved indholdet. Du behøver
            ikke have en konto. Du kan også bruge{" "}
            <Link href="/dsa/anmeld" className="font-medium text-groen hover:underline">anmeldelsesformularen</Link> og
            indsætte et link.
          </p>
          <p className={p}>
            Fortæl os, hvorfor indholdet er ulovligt, og skriv dit navn og din e-mail. Ved anmeldelser om seksuelt
            misbrug af børn kan du være anonym. Du får en kvittering med et sagsnummer, og vi giver dig besked, når vi
            har taget stilling. Den, du anmelder, får aldrig at vide, hvem du er.
          </p>
        </section>

        <section className={kort} aria-labelledby="behandling">
          <h2 id="behandling" className={h2}>Sådan behandler vi anmeldelser</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-tekst-daempet">
            <li>En medarbejder ser på alle anmeldelser. Vi træffer ingen afgørelser alene med automatik.</li>
            <li>Vi svarer som regel inden for 7 dage – og inden for 24 timer ved misbrug af børn og hadefuld tale.</li>
            <li>
              Vores automatiske kontrol stopper forbudte varer, når en auktion oprettes, og markerer mulige problemer,
              som en medarbejder derefter vurderer.
            </li>
            <li>Er der mistanke om en alvorlig forbrydelse, der truer liv eller sikkerhed, giver vi politiet besked.</li>
          </ul>
        </section>

        <section className={kort} aria-labelledby="begrundelse">
          <h2 id="begrundelse" className={h2}>Hvis vi fjerner noget, du har lagt op</h2>
          <p className={p}>
            Fjerner eller skjuler vi en auktion, et spørgsmål eller en bedømmelse – eller suspenderer eller lukker vi en
            konto – får du altid en begrundelse på mail. Den fortæller, hvad vi har gjort, hvilken regel eller lov det
            bygger på, hvad du konkret har gjort, om det blev opdaget automatisk eller af en medarbejder, og hvordan du
            klager.
          </p>
        </section>

        <section className={kort} aria-labelledby="klage">
          <h2 id="klage" className={h2}>Klag over en afgørelse</h2>
          <p className={p}>
            Du kan klage gratis inden for 6 måneder via linket i mailen eller under{" "}
            <Link href="/konto/afgoerelser" className="font-medium text-groen hover:underline">
              Min konto → Afgørelser
            </Link>
            . Har du anmeldt noget, og har vi valgt ikke at gribe ind, kan du også klage. Din klage behandles af en
            anden medarbejder end den, der traf afgørelsen, og du får et begrundet svar. Der er ét klagetrin.
          </p>
          <p className={p}>
            Er du stadig uenig, kan du indbringe sagen for et godkendt udenretligt tvistbilæggelsesorgan efter DSA
            artikel 21 eller for domstolene.
          </p>
        </section>

        <section className={kort} aria-labelledby="kontaktpunkt">
          <h2 id="kontaktpunkt" className={h2}>Kontaktpunkt for myndigheder og brugere</h2>
          <p className={p}>
            Myndigheder i EU, Europa-Kommissionen og Det Europæiske Råd for Digitale Tjenester samt brugere kan
            kontakte os direkte på:
          </p>
          <p className="mt-3 text-[15px] text-tekst">
            {/* TODO Filip: opret postkassen, og tilføj firmanavn, adresse og CVR, når de er på plads. */}
            <a href={`mailto:${DSA_KONTAKT_EMAIL}`} className="font-semibold text-groen hover:underline">
              {DSA_KONTAKT_EMAIL}
            </a>
          </p>
          <p className={p}>Vi kan kontaktes på dansk og engelsk.</p>
        </section>

        <section className={kort} aria-labelledby="rapport">
          <h2 id="rapport" className={h2}>Gennemsigtighed</h2>
          <p className={p}>
            Vi offentliggør hvert år en rapport med antal anmeldelser, indgreb, klager og suspenderinger.
          </p>
        </section>
      </div>
    </main>
  );
}
