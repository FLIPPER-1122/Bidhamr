import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import KontoSideHoved from "@/components/konto/KontoSideHoved";
import SkatteoplysningerForm from "@/components/dac7/SkatteoplysningerForm";
import { MitIDKnap } from "@/components/mitid/MitIDKraeves";
import { FORMULAR_FEJL, KORT } from "@/components/konto/felter";
import { datoDansk, hentMinDac7Status, hentMitMaskeredeCpr } from "@/lib/dac7/server";
import { DAC7 } from "@/lib/dac7/tekster";
import { kr } from "@/lib/dac7/regler";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Skatteoplysninger", robots: { index: false, follow: false } };

// Min konto → Skatteoplysninger (DAC7). Status for i år, formularen til
// adresse og CPR (vises, når sælgeren nærmer sig grænsen eller er bedt om
// oplysningerne) og kopien af det, BidHamr har indberettet. Alt hentes for
// den indloggede bruger (dac7_min_status udleder brugeren af auth.uid();
// det maskerede CPR hentes med brugerens eget id fra sessionen).
export default async function SkatSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const bruger = authData.user;
  if (!bruger) redirect("/login?redirect=/konto/skat");

  const status = await hentMinDac7Status(supabase);
  if (!status) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
        <KontoSideHoved titel={DAC7.sideTitel} krumme={DAC7.sideTitel} />
        <p role="alert" className={`mt-6 ${FORMULAR_FEJL}`}>
          {DAC7.fejl.generisk}
        </p>
      </main>
    );
  }

  const erFirma = status.konto_type === "erhverv";
  const harOplysninger = !!status.oplysninger;
  const visFormular = !erFirma && (status.naer || status.pligtig || !!status.anmodning || harOplysninger);
  const [cprMaske, kopiMasker] = await Promise.all([
    harOplysninger ? hentMitMaskeredeCpr(bruger.id) : Promise.resolve(null),
    Promise.all(
      status.indberetninger.map((i) =>
        i.data.cpr_oplyst ? hentMitMaskeredeCpr(bruger.id, i.aar) : Promise.resolve(null),
      ),
    ),
  ]);

  const statusTekst = erFirma
    ? DAC7.erhverv
    : status.pligtig
      ? DAC7.pligtig
      : status.naer
        ? DAC7.naer
        : DAC7.ikkeNaer;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <KontoSideHoved titel={DAC7.sideTitel} krumme={DAC7.sideTitel} tekst={DAC7.sideIntro} />

      {status.anmodning && (
        <section
          role="alert"
          className={`mt-6 rounded-[14px] border p-5 sm:p-6 ${
            status.anmodning.spaerret
              ? "border-fejl-kant bg-fejl-bg text-fejl-tekst"
              : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"
          }`}
        >
          <p className="font-medium">{DAC7.anmodningFrist(datoDansk(status.anmodning.frist))}</p>
          {status.anmodning.spaerret && <p className="mt-2 text-sm">{DAC7.spaerret}</p>}
        </section>
      )}

      <section className={`mt-6 ${KORT}`}>
        <h2 className="text-[20px] leading-tight lg:text-[22px]">{DAC7.statusTitel(status.aar)}</h2>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-kant p-4">
            <dt className="text-sm text-tekst-daempet">{DAC7.antalSalg}</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {status.antal} <span className="text-sm font-normal text-tekst-daempet">af {status.graense_antal}</span>
            </dd>
          </div>
          <div className="rounded-xl border border-kant p-4">
            <dt className="text-sm text-tekst-daempet">{DAC7.vederlag}</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {kr(status.vederlag_oere)}{" "}
              <span className="text-sm font-normal text-tekst-daempet">af {kr(status.graense_oere)}</span>
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-tekst-daempet">
          {DAC7.graenseTekst.replace("{kr}", kr(status.graense_oere))} {DAC7.vederlagForklaring}
        </p>
        <p className="mt-3 text-sm font-medium">{statusTekst}</p>
        {!erFirma && harOplysninger && status.mangler.length === 0 && (
          <p className="mt-1 text-sm text-succes-tekst">{DAC7.komplet}</p>
        )}
      </section>

      <section className={`mt-6 ${KORT}`}>
        <h2 className="text-[20px] leading-tight lg:text-[22px]">{DAC7.hvorforTitel}</h2>
        <p className="mt-2 text-sm text-tekst-daempet">{DAC7.hvorforTekst}</p>
      </section>

      {visFormular && (
        <section id="oplysninger" className={`mt-6 scroll-mt-24 ${KORT}`}>
          <h2 className="text-[20px] leading-tight lg:text-[22px]">{DAC7.formTitel}</h2>
          {status.mangler.includes("mitid") || !status.mitid ? (
            <div className="mt-3">
              <p className="text-sm">{DAC7.mitidMangler}</p>
              <div className="mt-3">
                <MitIDKnap retur="/konto/skat" fuldBredde />
              </div>
            </div>
          ) : (
            <>
              <p className="mt-1 text-sm text-tekst-daempet">{DAC7.formIntro}</p>
              <div className="mt-4">
                <SkatteoplysningerForm
                  navn={status.mitid.navn}
                  foedselsdato={status.mitid.foedselsdato}
                  adresse={status.oplysninger?.adresse ?? ""}
                  postnummer={status.oplysninger?.postnummer ?? ""}
                  bynavn={status.oplysninger?.bynavn ?? ""}
                  cprMaske={cprMaske}
                  harCpr={!!status.oplysninger?.cpr_oplyst}
                  andetTinLand={status.oplysninger?.andet_tin_land ?? null}
                />
              </div>
            </>
          )}
        </section>
      )}

      <section className={`mt-6 ${KORT}`}>
        <h2 className="text-[20px] leading-tight lg:text-[22px]">{DAC7.kopiTitel}</h2>
        <p className="mt-1 text-sm text-tekst-daempet">{DAC7.kopiIntro}</p>
        {status.indberetninger.length === 0 ? (
          <p className="mt-3 text-sm">{DAC7.kopiIngen}</p>
        ) : (
          <div className="mt-4 space-y-4">
            {status.indberetninger.map((i, idx) => (
              <article key={i.aar} className="rounded-xl border border-kant p-4">
                <h3 className="text-base font-semibold">{DAC7.kopiAar(i.aar)}</h3>
                <p className="text-xs text-tekst-daempet">Indberettet {datoDansk(i.indberettet_kl)}</p>
                <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
                  <dt className="text-tekst-daempet">Navn</dt>
                  <dd>{i.data.navn ?? "–"}</dd>
                  {i.data.konto_type === "erhverv" ? (
                    <>
                      <dt className="text-tekst-daempet">CVR-nummer</dt>
                      <dd>{i.data.cvr ?? "–"}</dd>
                    </>
                  ) : (
                    <>
                      <dt className="text-tekst-daempet">Fødselsdato</dt>
                      <dd>{i.data.foedselsdato ? datoDansk(i.data.foedselsdato) : "–"}</dd>
                      <dt className="text-tekst-daempet">CPR-nummer</dt>
                      <dd>{kopiMasker[idx] ?? (i.data.cpr_oplyst ? "oplyst" : "ikke oplyst")}</dd>
                    </>
                  )}
                  <dt className="text-tekst-daempet">Adresse</dt>
                  <dd>
                    {[i.data.adresse, [i.data.postnummer, i.data.bynavn].filter(Boolean).join(" ")]
                      .filter(Boolean)
                      .join(", ") || "–"}
                  </dd>
                  <dt className="text-tekst-daempet">{DAC7.antalSalg}</dt>
                  <dd>{i.data.antal}</dd>
                  <dt className="text-tekst-daempet">{DAC7.vederlag}</dt>
                  <dd>{kr(i.data.vederlag_oere)}</dd>
                  <dt className="text-tekst-daempet">{DAC7.gebyr}</dt>
                  <dd>{kr(i.data.gebyr_oere)}</dd>
                </dl>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-tekst-daempet">
                      <tr>
                        <th scope="col" className="py-1 pr-2 font-medium">Kvartal</th>
                        <th scope="col" className="py-1 pr-2 font-medium">{DAC7.antalSalg}</th>
                        <th scope="col" className="py-1 pr-2 font-medium">{DAC7.vederlag}</th>
                        <th scope="col" className="py-1 pr-2 font-medium">{DAC7.gebyr}</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {i.data.kvartaler.map((q, n) => (
                        <tr key={n} className="border-t border-kant">
                          <td className="py-1 pr-2">{DAC7.kvartal(n + 1)}</td>
                          <td className="py-1 pr-2">{q.antal}</td>
                          <td className="py-1 pr-2">{kr(q.vederlag_oere)}</td>
                          <td className="py-1 pr-2">{kr(q.gebyr_oere)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
