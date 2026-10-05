import Link from "next/link";
import type { Afsnit, FaqGruppe, Tekstside as TekstsideData } from "@/lib/tekster/sider/typer";

// Fælles visning af rene tekstsider (Sådan virker det, FAQ, Pakkeguide, Om,
// Cookies, Tilgængelighed). Indholdet ligger i src/lib/tekster/sider/.
// Serverkomponent uden JavaScript: FAQ bruger <details>.

function TekstLink({ href, tekst }: { href: string; tekst: string }) {
  const klasse =
    "font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";
  if (/^https?:\/\//.test(href)) {
    return (
      <a href={href} className={klasse} target="_blank" rel="noopener noreferrer">
        {tekst}
        <span className="sr-only"> (åbner i et nyt vindue)</span>
      </a>
    );
  }
  return (
    <Link href={href} className={klasse}>
      {tekst}
    </Link>
  );
}

function AfsnitBoks({ afsnit }: { afsnit: Afsnit }) {
  return (
    <section
      id={afsnit.id}
      aria-labelledby={`${afsnit.id}-overskrift`}
      className="scroll-mt-24 rounded-[14px] border border-kant bg-white p-6"
    >
      <h2 id={`${afsnit.id}-overskrift`} className="text-[20px] text-groen-mork sm:text-[22px]">
        {afsnit.overskrift}
      </h2>

      {afsnit.tekst?.map((t) => (
        <p key={t} className="mt-3 max-w-[65ch] text-[15px] leading-relaxed text-tekst">
          {t}
        </p>
      ))}

      {afsnit.trin && (
        <ol className="mt-4 flex flex-col gap-4">
          {afsnit.trin.map((t, i) => (
            <li key={t.titel} className="flex gap-3">
              <span
                aria-hidden
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-groen-lys text-[13px] font-semibold text-groen-mork"
              >
                {i + 1}
              </span>
              <div className="max-w-[65ch]">
                <h3 className="font-sans text-[15px] font-semibold text-tekst">{t.titel}</h3>
                <p className="mt-1 text-sm leading-relaxed text-tekst-daempet">{t.tekst}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {afsnit.punkter && (
        <ul className="mt-4 flex max-w-[65ch] flex-col gap-3">
          {afsnit.punkter.map((p) => (
            <li key={p} className="flex gap-3 text-sm leading-relaxed text-tekst">
              <span aria-hidden className="mt-2 h-2 w-2 shrink-0 rounded-full bg-groen" />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      )}

      {afsnit.note && (
        <p className="mt-4 max-w-[65ch] rounded-xl bg-groen-lys p-4 text-sm leading-relaxed text-groen-mork">
          {afsnit.note}
        </p>
      )}

      {afsnit.links && afsnit.links.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {afsnit.links.map((l) => (
            <li key={l.href}>
              <TekstLink href={l.href} tekst={l.tekst} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FaqBoks({ gruppe }: { gruppe: FaqGruppe }) {
  return (
    <section id={gruppe.id} aria-labelledby={`${gruppe.id}-overskrift`} className="scroll-mt-24">
      <h2 id={`${gruppe.id}-overskrift`} className="text-[20px] text-groen-mork sm:text-[22px]">
        {gruppe.overskrift}
      </h2>
      <div className="mt-4 flex flex-col gap-3">
        {gruppe.punkter.map((f) => (
          <details key={f.spoergsmaal} className="group rounded-xl border border-kant bg-white">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-5 py-4 text-sm font-semibold text-tekst focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen [&::-webkit-details-marker]:hidden">
              {f.spoergsmaal}
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 shrink-0 text-tekst-svag transition-transform group-open:rotate-180 motion-reduce:transition-none"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
              </svg>
            </summary>
            <p className="max-w-[65ch] border-t border-kant px-5 py-4 text-sm leading-relaxed text-tekst-daempet">
              {f.svar}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

export default function Tekstside({ side }: { side: TekstsideData }) {
  return (
    <main className="mx-auto w-full max-w-[880px] flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <header className="max-w-[65ch]">
        <h1 className="text-[26px] leading-tight text-groen-mork sm:text-[32px]">{side.titel}</h1>
        {side.senestOpdateret && (
          <p className="mt-2 text-xs text-tekst-svag">Senest opdateret {side.senestOpdateret}</p>
        )}
        <p className="mt-4 text-base leading-relaxed text-tekst-daempet">{side.intro}</p>
      </header>

      {side.afsnit.length > 0 && (
        <div className="mt-8 flex flex-col gap-6">
          {side.afsnit.map((a) => (
            <AfsnitBoks key={a.id} afsnit={a} />
          ))}
        </div>
      )}

      {side.faq && side.faq.length > 0 && (
        <div className="mt-8 flex flex-col gap-10">
          {side.faq.map((g) => (
            <FaqBoks key={g.id} gruppe={g} />
          ))}
        </div>
      )}
    </main>
  );
}
