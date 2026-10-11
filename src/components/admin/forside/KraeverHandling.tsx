import Link from "next/link";
import { AdminPrik } from "@/components/admin/AdminBadge";

// "Kræver handling" på forsiden (docs/ADMIN-REDESIGN.md 3.3): én liste - ikke
// mange ens kort - sorteret efter alvor. Hver række: alvor-prik, titel, kort
// forklaring, frist-chip, antal og "Gå til". På mobil bliver rækken et kort.
// Frist/ældste vises kun, hvor vi kender den - aldrig et gæt.

export type HandlingAlvor = "roed" | "gul" | "graa";

export type HandlingRaekke = {
  id: string;
  alvor: HandlingAlvor;
  titel: string;
  antal: number;
  forklaring?: string;
  frist?: { tekst: string; alvor: HandlingAlvor };
  href: string;
};

const RANG: Record<HandlingAlvor, number> = { roed: 0, gul: 1, graa: 2 };

const FRIST: Record<HandlingAlvor, string> = {
  roed: "bg-fejl-bg text-fejl-tekst",
  gul: "bg-advarsel-bg text-advarsel-tekst",
  graa: "bg-admin-graa text-tekst-daempet",
};

export function sorterHandling(r: HandlingRaekke[]): HandlingRaekke[] {
  return r
    .filter((x) => x.antal > 0)
    .map((x, i) => ({ x, i }))
    .sort((a, b) => RANG[a.x.alvor] - RANG[b.x.alvor] || a.i - b.i)
    .map(({ x }) => x);
}

export default function KraeverHandling({
  raekker,
  tomLink = { href: "/admin/sager?vis=afgjorte", label: "Se afgjorte sager" },
}: {
  raekker: HandlingRaekke[];
  tomLink?: { href: string; label: string };
}) {
  const liste = sorterHandling(raekker);
  return (
    <section aria-labelledby="kraever-handling" className="space-y-2.5">
      <h2 id="kraever-handling" className="text-[13px] font-semibold uppercase tracking-[0.06em] text-tekst-svag">
        Kræver handling
      </h2>
      <div className="overflow-hidden rounded-[14px] border border-admin-kant bg-white">
        {liste.length === 0 ? (
          <p role="status" className="bg-succes-bg px-5 py-6 text-center text-sm text-succes-tekst">
            <span aria-hidden="true">✓ </span>Der er intet, der venter på dig.{" "}
            <Link href={tomLink.href} className="font-semibold underline">
              {tomLink.label}
            </Link>
          </p>
        ) : (
          <ul>
            {liste.map((r) => (
              <li
                key={r.id}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3.5 gap-y-2 border-t border-admin-kant px-4 py-3 first:border-t-0 sm:grid-cols-[auto_1fr_auto_auto_auto]"
              >
                <AdminPrik tone={r.alvor} />
                <div className="min-w-0">
                  <p className="font-semibold text-tekst">{r.titel}</p>
                  {r.forklaring && <p className="text-[13px] text-tekst-daempet">{r.forklaring}</p>}
                </div>
                <span className="min-w-7 text-right text-base font-bold tabular-nums text-tekst sm:order-2">{r.antal}</span>
                {/* Mobil: frist og knap på linjen under titlen. Computer: hver sin kolonne. */}
                <div className="col-start-2 col-end-4 flex flex-wrap items-center gap-2 sm:contents">
                  {r.frist ? (
                    <span className={`whitespace-nowrap rounded-full px-[9px] py-[3px] text-[12.5px] sm:order-1 ${FRIST[r.frist.alvor]}`}>
                      {r.frist.tekst}
                    </span>
                  ) : (
                    <span aria-hidden="true" className="hidden sm:order-1 sm:block" />
                  )}
                  <Link
                    href={r.href}
                    className="inline-flex min-h-10 items-center justify-center rounded-lg bg-orange-knap px-3.5 text-sm font-semibold text-white transition-colors hover:bg-orange-knap-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:order-3"
                  >
                    Gå til<span className="sr-only">: {r.titel.toLowerCase()}</span>
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
