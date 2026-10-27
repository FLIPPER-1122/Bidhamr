import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import KontoSideHoved from "@/components/konto/KontoSideHoved";
import DelLink from "@/components/henvisning/DelLink";
import { hentMinHenvisning } from "@/lib/henvisning/status";
import { HENVISNING_TEKST as T } from "@/lib/tekster/henvisning";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Henvis en ven", robots: { index: false, follow: false } };

// Standard, hvis status ikke kan hentes (samme som henvisning_indstillinger).
const STANDARD_POINT = 10;

function dato(iso: string) {
  return new Date(iso).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Copenhagen",
  });
}

// Min konto -> Henvis en ven: eget link, kopiér/del, antal venner, optjente
// point og månedens loft. min_henvisning() udleder brugeren af auth.uid() -
// man ser kun sine egne henvisninger og kun vennens korte visningsnavn.
export default async function HenvisSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/konto/henvis");

  const h = await hentMinHenvisning(supabase);
  const point = h && h.kan_henvise ? h.point_pr_ven : STANDARD_POINT;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <KontoSideHoved titel={T.sideTitel} krumme={T.sideTitel} tekst={T.sideIntro(point)} />

      {!h ? (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {T.fejl}
        </p>
      ) : !h.kan_henvise ? (
        <p className="mt-6 rounded-none border border-kant bg-white p-5 text-sm text-tekst">{T.kunPrivate}</p>
      ) : (
        <>
          <section aria-label={T.linkLabel} className="mt-6 rounded-none border border-kant bg-white p-5 sm:p-6">
            <DelLink url={h.url} />
            {!h.optjening_aaben && (
              <p role="status" className="mt-4 rounded-lg border border-kant bg-groen-lys p-3 text-sm text-tekst">
                {T.foerLancering}
              </p>
            )}
            {!h.kan_faa_point && (
              <p role="status" className="mt-4 rounded-lg border border-advarsel-kant bg-advarsel-bg p-3 text-sm text-advarsel-tekst">
                {T.spaerret}
              </p>
            )}
          </section>

          <dl className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              [T.tal.venner, String(h.antal_venner)],
              [T.tal.point, String(h.point_i_alt)],
              [T.tal.maaned, T.maanedVaerdi(h.belonnet_denne_maaned, h.maks_pr_maaned)],
            ].map(([navn, vaerdi]) => (
              <div key={navn} className="rounded-none border border-kant bg-white p-4">
                <dt className="text-[13px] text-tekst-daempet">{navn}</dt>
                <dd className="mt-1 text-[24px] leading-tight font-bold text-tekst tabular-nums">{vaerdi}</dd>
              </div>
            ))}
          </dl>

          <section aria-labelledby="regler-titel" className="mt-6 rounded-none border border-kant bg-white p-5 sm:p-6">
            <h2 id="regler-titel" className="text-[20px] leading-tight lg:text-[22px]">
              {T.reglerTitel}
            </h2>
            <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-tekst-daempet">
              {T.regler(h.point_pr_ven, h.maks_pr_maaned).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <Link href="/konto/boost" className="btn btn-sekundaer mt-4">
              Se dine boost-point
            </Link>
          </section>

          <section aria-labelledby="venner-titel" className="mt-6">
            <h2 id="venner-titel" className="text-[20px] leading-tight lg:text-[22px]">
              {T.vennerTitel}
            </h2>
            {h.venner.length === 0 ? (
              <p className="mt-2 text-sm text-tekst-daempet">{T.vennerTom}</p>
            ) : (
              <ul className="mt-3 divide-y divide-kant rounded-none border border-kant bg-white">
                {h.venner.map((v, i) => (
                  <li key={`${v.oprettet_kl}-${i}`} className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="text-[15px] font-medium text-tekst">{v.navn}</p>
                      <p className="mt-0.5 text-[13px] text-tekst-svag">
                        {dato(v.oprettet_kl)} · {T.status[v.status] ?? v.status}
                      </p>
                    </div>
                    <p
                      className={`shrink-0 text-[15px] font-semibold tabular-nums ${v.point > 0 ? "text-succes-tekst" : "text-tekst-svag"}`}
                    >
                      {v.point > 0 ? `+${v.point}` : "0"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
