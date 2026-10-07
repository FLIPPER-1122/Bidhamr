import type { Metadata } from "next";
import Link from "next/link";
import { ERHVERV_SIDE, ERHVERV_SIDE_EKSTRA } from "@/lib/tekster/erhverv";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";
import { E_KNAP_PRIMAER } from "@/components/erhverv/stil";

// Siden "Erhverv" (ROADMAP fase 7). Offentlig - også før lancering og uden
// login (OFFENTLIGE_RUTER i src/lib/supabase/middleware.ts). Ingen priser her.
// Målgruppen er primært ældre: stor tekst, store knapper, én ting ad gangen.

export const metadata: Metadata = {
  title: ERHVERV_SIDE.titel,
  description: ERHVERV_SIDE.metabeskrivelse,
  alternates: { canonical: "/erhverv" },
};

function FormularKnap() {
  return (
    <div className="flex flex-col items-start gap-3">
      <Link href="/erhverv/formular" className={`${E_KNAP_PRIMAER} w-full sm:w-auto sm:px-10`}>
        {ERHVERV_SIDE.knapFormular}
      </Link>
      <p className="text-[17px] text-tekst-daempet">{ERHVERV_SIDE.knapTekst}</p>
    </div>
  );
}

export default function ErhvervSide() {
  return (
    <main className="flex-1 bg-white">
      {/* Top */}
      <section className="bg-groen-lys">
        <div className="mx-auto max-w-[960px] px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
          <h1 className="text-[30px] leading-tight text-groen-mork sm:text-[40px]">{ERHVERV_SIDE.titel}</h1>
          <div className="mt-4 max-w-[60ch] space-y-3 text-[18px] leading-relaxed text-tekst">
            {ERHVERV_SIDE.intro.map((t) => (
              <p key={t}>{t}</p>
            ))}
          </div>
          <div className="mt-8">
            <FormularKnap />
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-[960px] space-y-14 px-4 py-12 sm:px-6 lg:px-8">
        {/* Fordele */}
        <section aria-labelledby="fordele">
          <h2 id="fordele" className="text-[24px] leading-tight sm:text-[28px]">
            {ERHVERV_SIDE.fordeleOverskrift}
          </h2>
          <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
            {ERHVERV_SIDE.fordele.map((f) => (
              <li key={f.titel} className="rounded-[14px] border border-kant bg-white p-6">
                <h3 className="font-sans text-[19px] font-semibold text-groen-mork">{f.titel}</h3>
                <p className="mt-2 text-[17px] leading-relaxed text-tekst">{f.tekst}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Trin */}
        <section aria-labelledby="trin">
          <h2 id="trin" className="text-[24px] leading-tight sm:text-[28px]">
            {ERHVERV_SIDE.trinOverskrift}
          </h2>
          <ol className="mt-6 space-y-4">
            {ERHVERV_SIDE.trin.map((t, i) => (
              <li key={t.titel} className="flex gap-4 rounded-[14px] bg-groen-lys p-6">
                <span
                  aria-hidden="true"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-groen text-[20px] font-semibold text-white"
                >
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-sans text-[19px] font-semibold text-groen-mork">
                    <span className="sr-only">Trin {i + 1}: </span>
                    {t.titel}
                  </h3>
                  <p className="mt-1 text-[17px] leading-relaxed text-tekst">{t.tekst}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-8">
            <FormularKnap />
          </div>
        </section>

        {/* Spørgsmål og svar - altid åbne (ingen skjulte svar) */}
        <section aria-labelledby="faq">
          <h2 id="faq" className="text-[24px] leading-tight sm:text-[28px]">
            {ERHVERV_SIDE.faqOverskrift}
          </h2>
          <dl className="mt-6 divide-y divide-kant rounded-[14px] border border-kant">
            {ERHVERV_SIDE.faq.map((f) => (
              <div key={f.spoergsmaal} className="p-6">
                <dt className="text-[18px] font-semibold text-tekst">{f.spoergsmaal}</dt>
                <dd className="mt-2 text-[17px] leading-relaxed text-tekst-daempet">{f.svar}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rounded-[14px] bg-groen-lys p-6 sm:p-8">
          <FormularKnap />
          <p className="mt-6 text-[17px] text-tekst">
            {ERHVERV_SIDE_EKSTRA.kontaktLinje}{" "}
            <a
              href={`mailto:${ERHVERV_EMAIL}`}
              className="font-semibold text-groen underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              {ERHVERV_EMAIL}
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
