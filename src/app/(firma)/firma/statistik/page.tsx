import { hentFirmaStatistik, kraevFirma } from "@/lib/erhverv/firmaData";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_TEKST } from "@/components/erhverv/stil";
import { FIRMA_DASHBOARD as D } from "@/lib/tekster/erhverv";
import { kr } from "@/lib/erhverv/visning";

// Statistik: visninger, bud og salg pr. måned (seneste 12) og pr. auktion
// (firma_statistik). Bevidst enkelt: tabeller og en vandret søjle pr.
// måned - ingen grafer, der skal tolkes. Visninger tælles fra auction_views.

export const metadata = { title: D.statistik.titel };

const S = D.statistik;

function maanedNavn(maaned: string) {
  const [aar, md] = maaned.split("-").map(Number);
  return new Date(Date.UTC(aar, md - 1, 15)).toLocaleDateString("da-DK", { month: "long", year: "numeric", timeZone: "UTC" });
}

const tal = (n: number) => n.toLocaleString("da-DK");
const th = "px-3 py-3 text-left text-[17px] font-semibold text-tekst";
const td = "px-3 py-3 text-[18px] text-tekst tabular-nums";

export default async function FirmaStatistikSide() {
  await kraevFirma("/firma/statistik");
  const s = await hentFirmaStatistik();
  const maaneder = [...(s?.maaneder ?? [])].reverse();
  const auktioner = s?.auktioner ?? [];
  const maks = Math.max(1, ...maaneder.map((m) => m.visninger));
  const ingenTal = auktioner.length === 0;

  return (
    <FirmaSide titel={S.titel} intro={S.intro}>
      {ingenTal ? (
        <Kort id="tom">
          <p className={E_TEKST}>{S.tom}</p>
        </Kort>
      ) : (
        <>
          <Kort id="pr-maaned" titel={S.prMaaned} forklaring={S.prMaanedForklaring}>
            {/* Mobil: én boks pr. måned (ingen tabel, der skal rulles sidelæns). */}
            <ul className="space-y-3 sm:hidden">
              {maaneder.map((m) => (
                <li key={m.maaned} className="rounded-[14px] border border-kant p-4">
                  <p className="text-[19px] font-semibold text-tekst capitalize">{maanedNavn(m.maaned)}</p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[17px]">
                    <dt className="text-tekst-daempet">{S.kolonneVisninger}</dt>
                    <dd className="font-semibold text-tekst tabular-nums">{tal(m.visninger)}</dd>
                    <dt className="text-tekst-daempet">{S.kolonneBud}</dt>
                    <dd className="font-semibold text-tekst tabular-nums">{tal(m.bud)}</dd>
                    <dt className="text-tekst-daempet">{S.kolonneSolgte}</dt>
                    <dd className="font-semibold text-tekst tabular-nums">{tal(m.solgte)}</dd>
                    <dt className="text-tekst-daempet">{S.kolonneOmsaetning}</dt>
                    <dd className="font-semibold text-tekst tabular-nums">{kr(Number(m.omsaetning))}</dd>
                  </dl>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[560px] border-collapse">
                <thead className="border-b-2 border-kant">
                  <tr>
                    <th scope="col" className={th}>{S.kolonneMaaned}</th>
                    <th scope="col" className={th}>{S.kolonneVisninger}</th>
                    <th scope="col" className={th}>{S.kolonneBud}</th>
                    <th scope="col" className={th}>{S.kolonneSolgte}</th>
                    <th scope="col" className={th}>{S.kolonneOmsaetning}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-kant">
                  {maaneder.map((m) => (
                    <tr key={m.maaned}>
                      <th scope="row" className={`${th} font-normal capitalize`}>{maanedNavn(m.maaned)}</th>
                      <td className={td}>
                        <div className="flex items-center gap-3">
                          <span className="w-14 shrink-0">{tal(m.visninger)}</span>
                          <span
                            aria-hidden="true"
                            className="block h-4 rounded bg-groen"
                            style={{ width: `${Math.round((m.visninger / maks) * 100)}%`, maxWidth: "140px", minWidth: m.visninger ? "4px" : 0 }}
                          />
                        </div>
                      </td>
                      <td className={td}>{tal(m.bud)}</td>
                      <td className={td}>{tal(m.solgte)}</td>
                      <td className={td}>{kr(Number(m.omsaetning))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Kort>

          <Kort id="pr-auktion" titel={S.prAuktion} forklaring={S.prAuktionForklaring}>
            <ul className="divide-y divide-kant rounded-[14px] border border-kant">
              {auktioner.map((a) => (
                <li key={a.id} className="p-4">
                  <p className="text-[19px] font-semibold break-words text-tekst">{a.titel}</p>
                  <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-[17px] sm:grid-cols-3">
                    <div>
                      <dt className="inline text-tekst-daempet">{S.kolonneVisninger}: </dt>
                      <dd className="inline font-semibold text-tekst tabular-nums">{tal(a.visninger)}</dd>
                    </div>
                    <div>
                      <dt className="inline text-tekst-daempet">{S.kolonneBud}: </dt>
                      <dd className="inline font-semibold text-tekst tabular-nums">{tal(a.bud)}</dd>
                    </div>
                    <div>
                      <dt className="inline text-tekst-daempet">{S.kolonneSolgtFor}: </dt>
                      <dd className="inline font-semibold text-tekst">
                        {a.solgt_for != null ? kr(Number(a.solgt_for)) : a.status === "aktiv" ? S.koerer : S.ikkeSolgt}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </Kort>
        </>
      )}
    </FirmaSide>
  );
}
