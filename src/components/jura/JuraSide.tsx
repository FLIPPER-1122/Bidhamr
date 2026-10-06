import Link from "next/link";
import type { Blok, Inline, JuraDokument } from "@/lib/jura/juraDokument";
import { PLADSHOLDER } from "@/lib/jura/juraDokument";
import { VILKAAR_DATO, VILKAAR_ER_UDKAST, VILKAAR_VERSION } from "@/lib/vilkaar";

// Visning af brugerbetingelser og privatlivspolitik (jura/*-udkast.md).
// Samme udtryk som Tekstside (src/components/Tekstside.tsx): kort pr. afsnit,
// overskrifter med ankre, læsbar linjelængde og tabeller som kort på mobil.
// Serverkomponent uden JavaScript.

const LINK =
  "font-medium text-groen underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";

function InlineVisning({ dele }: { dele: Inline[] }) {
  return (
    <>
      {dele.map((d, i) => {
        switch (d.type) {
          case "tekst":
            return <span key={i}>{d.tekst}</span>;
          case "fed":
            return (
              <strong key={i} className="font-semibold text-tekst">
                <InlineVisning dele={d.indhold} />
              </strong>
            );
          case "kode":
            return (
              <code key={i} className="rounded bg-groen-lys px-1 py-0.5 font-mono text-[13px] text-groen-mork">
                {d.tekst}
              </code>
            );
          case "link":
            return d.href.startsWith("/") ? (
              <Link key={i} href={d.href} className={`${LINK} break-words`}>
                {d.tekst}
              </Link>
            ) : (
              <a key={i} href={d.href} className={`${LINK} break-all`}>
                {d.tekst}
              </a>
            );
          case "pladsholder":
            return (
              <span
                key={i}
                className="whitespace-nowrap rounded bg-advarsel-bg px-1.5 py-0.5 text-[13px] font-medium text-advarsel-tekst"
              >
                {PLADSHOLDER}
              </span>
            );
        }
      })}
    </>
  );
}

function tekstAf(dele: Inline[]): string {
  return dele
    .map((d) =>
      d.type === "fed" ? tekstAf(d.indhold) : d.type === "pladsholder" ? PLADSHOLDER : d.tekst,
    )
    .join("");
}

function TabelVisning({ blok, titel }: { blok: Extract<Blok, { type: "tabel" }>; titel: string }) {
  const [, ...ovrige] = blok.kolonner;
  return (
    <>
      {/* Mobil: ét kort pr. række */}
      <ul aria-label={titel} className="mt-4 flex flex-col gap-3 md:hidden">
        {blok.raekker.map((r, ri) => (
          <li key={ri} className="rounded-xl border border-kant p-4">
            <p className="text-sm font-semibold text-tekst">
              <InlineVisning dele={r[0] ?? []} />
            </p>
            <dl className="mt-2 flex flex-col gap-2">
              {ovrige.map((k, i) => (
                <div key={i}>
                  <dt className="text-xs font-medium text-tekst-svag">{tekstAf(k)}</dt>
                  <dd className="text-sm leading-relaxed text-tekst">
                    <InlineVisning dele={r[i + 1] ?? []} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      {/* Bred skærm: almindelig tabel */}
      <div className="mt-4 hidden overflow-hidden rounded-xl border border-kant md:block">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{titel}</caption>
          <thead className="bg-groen-lys text-groen-mork">
            <tr>
              {blok.kolonner.map((k, i) => (
                <th key={i} scope="col" className="px-4 py-3 font-semibold">
                  <InlineVisning dele={k} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {blok.raekker.map((r, ri) => (
              <tr key={ri} className="border-t border-kant align-top">
                <th scope="row" className="w-[26%] px-4 py-3 font-semibold text-tekst">
                  <InlineVisning dele={r[0] ?? []} />
                </th>
                {r.slice(1).map((c, i) => (
                  <td key={i} className="px-4 py-3 leading-relaxed text-tekst">
                    <InlineVisning dele={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BlokVisning({ blok, afsnitTitel }: { blok: Blok; afsnitTitel: string }) {
  switch (blok.type) {
    case "afsnit":
      return (
        <p className="mt-3 max-w-[70ch] text-[15px] leading-relaxed text-tekst">
          {blok.nummer && (
            <span className="mr-1.5 font-semibold tabular-nums text-groen-mork">{blok.nummer}</span>
          )}
          <InlineVisning dele={blok.indhold} />
        </p>
      );
    case "liste":
      return (
        <ul className="mt-3 flex max-w-[70ch] flex-col gap-2">
          {blok.punkter.map((p, i) => (
            <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-tekst">
              <span aria-hidden className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-groen" />
              <span className="min-w-0">
                <InlineVisning dele={p} />
              </span>
            </li>
          ))}
        </ul>
      );
    case "tabel":
      return <TabelVisning blok={blok} titel={afsnitTitel} />;
    case "underoverskrift":
      return (
        <h3 id={blok.id} className="mt-6 scroll-mt-24 font-sans text-[16px] font-semibold text-tekst">
          {blok.tekst}
        </h3>
      );
  }
}

export type KrydsLink = { href: string; tekst: string };

export default function JuraSide({
  dokument,
  intro,
  krydslinks,
}: {
  dokument: JuraDokument;
  intro: string;
  krydslinks: KrydsLink[];
}) {
  return (
    <main className="mx-auto w-full max-w-[880px] flex-1 px-4 py-8 sm:px-6 lg:py-10">
      {VILKAAR_ER_UDKAST && (
        <div
          role="note"
          className="mb-6 rounded-[14px] border border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst sm:p-5"
        >
          <p className="text-[15px] font-semibold">UDKAST – skal godkendes af advokat</p>
          <p className="mt-1 text-sm leading-relaxed">
            Version {VILKAAR_VERSION} – {VILKAAR_DATO}. Teksten er et udkast og kan blive ændret, før BidHamr
            åbner. Felter markeret {PLADSHOLDER} bliver udfyldt inden lancering.
          </p>
        </div>
      )}

      <header className="max-w-[70ch]">
        <h1 className="text-[26px] leading-tight text-groen-mork sm:text-[32px]">{dokument.titel}</h1>
        <p className="mt-2 text-xs text-tekst-svag">
          Version {VILKAAR_VERSION} – {VILKAAR_DATO}
        </p>
        <p className="mt-4 text-base leading-relaxed text-tekst-daempet">{intro}</p>
      </header>

      <nav aria-labelledby="indhold-overskrift" className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
        <h2 id="indhold-overskrift" className="font-sans text-[15px] font-semibold text-tekst">
          Indhold
        </h2>
        <ol className="mt-3 gap-x-8 text-sm sm:columns-2">
          {dokument.afsnit.map((a) => (
            <li key={a.id} className="break-inside-avoid">
              <a
                href={`#${a.id}`}
                className="inline-flex min-h-11 items-center rounded-md text-groen-mork hover:text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:min-h-8"
              >
                {a.overskrift}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-6 flex flex-col gap-6">
        {dokument.afsnit.map((a) => (
          <section
            key={a.id}
            id={a.id}
            aria-labelledby={`${a.id}-overskrift`}
            className="scroll-mt-24 rounded-[14px] border border-kant bg-white p-5 sm:p-6"
          >
            <h2 id={`${a.id}-overskrift`} className="text-[20px] text-groen-mork sm:text-[22px]">
              <a href={`#${a.id}`} className="hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
                {a.overskrift}
              </a>
            </h2>
            {a.blokke.map((b, i) => (
              <BlokVisning key={i} blok={b} afsnitTitel={a.overskrift} />
            ))}
          </section>
        ))}
      </div>

      <nav aria-label="Se også" className="mt-8 rounded-[14px] bg-groen-lys p-5 text-sm text-groen-mork">
        <p className="font-semibold">Se også</p>
        <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
          {krydslinks.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className={`${LINK} inline-flex min-h-11 items-center sm:min-h-8`}>
                {l.tekst}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-3">
          <a href="#indhold-overskrift" className={LINK}>
            Til toppen
          </a>
        </p>
      </nav>
    </main>
  );
}
