import Link from "next/link";
import { kraevSideRolle } from "@/lib/adminAuth";
import { erTestdatabase } from "@/lib/miljoe";
import {
  CLAIM_HAENGER_MIN,
  CRON_ADVARSEL_MIN,
  type Sektion,
  hentCronRute,
  hentFejlGrupper,
  hentHttpSvar,
  hentIkkeSendte,
  hentPgCron,
} from "@/lib/driftData";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import { hentBesoeg, stiNavn } from "@/lib/statistik";

// Drift: cron-jobs, notifikationer der ikke er sendt, og fejl på siden.
// Kun admin og chef (tjekkes på serveren). Ingen mailindhold og ingen
// persondata ud over modtagerens id og maskerede e-mail.

const DAGE_VALG = [1, 7, 30] as const;

const TZ = "Europe/Copenhagen";
const tid = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short", timeZone: TZ })
    : "—";

function naa() {
  return Date.now();
}

function siden(iso: string | null, nu: number): string {
  if (!iso) return "aldrig";
  const min = Math.max(0, Math.round((nu - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "lige nu";
  if (min < 60) return `${min} min. siden`;
  const t = Math.floor(min / 60);
  if (t < 48) return `${t} t. siden`;
  return `${Math.floor(t / 24)} dage siden`;
}

function varighed(start: string, slut: string | null): string {
  if (!slut) return "—";
  const ms = new Date(slut).getTime() - new Date(start).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const KILDE: Record<string, string> = {
  klient: "Browser",
  server: "Server",
  action: "Handling",
  cron: "Cron",
  webhook: "Webhook",
  notifikation: "Notifikation",
};

function Badge({ farve, children }: { farve: "groen" | "roed" | "gul" | "graa"; children: React.ReactNode }) {
  const cls = {
    groen: "bg-green-100 text-green-800",
    roed: "bg-red-100 text-red-800",
    gul: "bg-amber-100 text-amber-800",
    graa: "bg-neutral-100 text-neutral-700",
  }[farve];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${cls}`}>
      {children}
    </span>
  );
}

function Kort({ titel, children, hoejre }: { titel: string; children: React.ReactNode; hoejre?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3 sm:px-5">
        <h2 className="text-base font-semibold text-neutral-900">{titel}</h2>
        {hoejre}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function SektionFejl<T>({ s }: { s: Sektion<T> }) {
  if (s.tilstand === "mangler") {
    return (
      <p className="text-sm text-amber-800">
        Ikke tilgængelig endnu: migrationen <code className="text-xs">20261005060000_admin_drift.sql</code> er
        ikke kørt på denne database.
      </p>
    );
  }
  if (s.tilstand === "fejl") {
    return <p className="text-sm text-red-700">Kunne ikke hentes: {s.besked}</p>;
  }
  return null;
}

const th = "px-3 py-2 text-left font-medium";
const td = "px-3 py-2 align-top";

export default async function AdminDrift({
  searchParams,
}: {
  searchParams: Promise<{ dage?: string }>;
}) {
  const { admin } = await kraevSideRolle("admin");
  const { dage: dageParam } = await searchParams;
  const dage = DAGE_VALG.find((d) => String(d) === dageParam) ?? 7;
  const nu = naa();

  const [rute, pgCron, http, ikkeSendte, fejl, besoeg] = await Promise.all([
    hentCronRute(admin, nu),
    hentPgCron(admin),
    hentHttpSvar(admin),
    hentIkkeSendte(admin, nu),
    hentFejlGrupper(admin, nu, dage),
    hentBesoeg(admin, 30),
  ]);

  // Advarsel: ingen vellykket kørsel af vores cron-rute i 15 minutter.
  // Testdatabasen kalder bevidst ikke cron-ruten (ingen cron_url/cron_secret i
  // Vault). Er der aldrig logget en kørsel og ingen pg_net-svar, vises en
  // neutral besked i stedet for den røde advarsel. Kun på testdatabasen –
  // erTestdatabase() er fail closed, så produktion viser altid advarslen.
  const ruteIkkeKaldtPaaTest =
    erTestdatabase() &&
    rute.tilstand === "ok" &&
    !rute.data.sidsteOk &&
    rute.data.seneste.length === 0 &&
    http.tilstand === "ok" &&
    http.data.length === 0;

  const ruteAdvarsel =
    !ruteIkkeKaldtPaaTest &&
    rute.tilstand === "ok" &&
    (!rute.data.sidsteOk ||
      nu - new Date(rute.data.sidsteOk).getTime() > CRON_ADVARSEL_MIN * 60_000);

  const httpFejl =
    http.tilstand === "ok"
      ? http.data.filter((h) => h.timed_out || h.fejl || (h.status_code ?? 0) >= 300 || h.status_code === null)
      : [];

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <AdminSideHoved
        titel="Drift"
        forklaring="Teknisk overblik: besøg, cron-jobs, notifikationer der ikke er sendt, og fejl på siden. Opdateres, når siden genindlæses."
      />

      {/* ---------------------------------------------------------- Besøg */}
      <Kort titel="Besøg (cookiefri statistik)">
        {besoeg.tilstand === "mangler" ? (
          <p className="text-sm text-amber-800">
            Ikke tilgængelig endnu: migrationen <code className="text-xs">20261006050000_statistik.sql</code> er
            ikke kørt på denne database.
          </p>
        ) : besoeg.tilstand === "fejl" ? (
          <p className="text-sm text-red-700">Kunne ikke hentes: {besoeg.besked}</p>
        ) : (
          <div className="space-y-5">
            <dl className="grid grid-cols-3 gap-3 text-sm">
              {[
                { label: "I dag", v: besoeg.data.iDag },
                { label: "Sidste 7 dage", v: besoeg.data.dage7 },
                { label: "Sidste 30 dage", v: besoeg.data.dage30 },
              ].map((t) => (
                <div key={t.label} className="rounded-lg bg-neutral-50 p-3">
                  <dt className="text-xs text-neutral-500">{t.label}</dt>
                  <dd className="text-xl font-semibold text-neutral-900">{t.v.toLocaleString("da-DK")}</dd>
                </div>
              ))}
            </dl>

            {besoeg.data.prDag.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-neutral-800">Sidevisninger pr. dag (30 dage)</h3>
                {(() => {
                  const maks = Math.max(1, ...besoeg.data.prDag.map((d) => d.antal));
                  return (
                    <div className="flex h-24 items-end gap-0.5" aria-hidden="true">
                      {besoeg.data.prDag.map((d) => (
                        <div
                          key={d.dag}
                          title={`${d.dag}: ${d.antal.toLocaleString("da-DK")}`}
                          className="min-w-[3px] flex-1 rounded-t bg-groen"
                          style={{ height: `${Math.max(4, Math.round((d.antal / maks) * 100))}%` }}
                        />
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}

            <div>
              <h3 className="mb-2 text-sm font-semibold text-neutral-800">Mest besøgte sider (30 dage)</h3>
              {besoeg.data.top.length === 0 ? (
                <p className="text-sm text-neutral-500">Ingen besøg registreret endnu.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-neutral-50 text-xs uppercase text-neutral-500">
                      <th className={th}>Side</th>
                      <th className={`${th} text-right`}>Visninger</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {besoeg.data.top.map((r) => (
                      <tr key={r.sti}>
                        <td className={td}>
                          <span className="text-neutral-900">{stiNavn(r.sti)}</span>
                          {stiNavn(r.sti) !== r.sti && (
                            <span className="ml-2 font-mono text-xs text-neutral-500">{r.sti}</span>
                          )}
                        </td>
                        <td className={`${td} text-right tabular-nums`}>{r.antal.toLocaleString("da-DK")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <p className="text-xs text-neutral-500">
              Tæller kun sidevisninger pr. dag og sidetype. Ingen cookies, intet bruger-id, ingen IP og ingen
              tredjepart. Besøgende med Do Not Track tælles ikke. Admin-sider tælles ikke.
            </p>
          </div>
        )}
      </Kort>

      {/* ---------------------------------------------------------- Cron */}
      <Kort
        titel="Cron-rute (betalings-cron)"
        hoejre={
          rute.tilstand === "ok" ? (
            ruteIkkeKaldtPaaTest ? (
              <Badge farve="graa">Ikke i brug på testdatabasen</Badge>
            ) : ruteAdvarsel ? (
              <Badge farve="roed">Ingen vellykket kørsel i over {CRON_ADVARSEL_MIN} min.</Badge>
            ) : (
              <Badge farve="groen">Kører</Badge>
            )
          ) : null
        }
      >
        <SektionFejl s={rute} />
        {rute.tilstand === "ok" && (
          <div className="space-y-4">
            {ruteIkkeKaldtPaaTest && (
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-700">
                Ingen kørsler logget endnu. Cron-ruten kaldes kun fra produktionsdatabasen – på
                testdatabasen er det normalt.
              </div>
            )}
            {ruteAdvarsel && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                Sidste vellykkede kørsel: <strong>{siden(rute.data.sidsteOk, nu)}</strong>. Ruten skal
                køre hvert 5. minut (pg_cron-jobbet <code>betalings-cron</code>). Tjek jobbet og
                svarene fra pg_net nedenfor, og at <code>cron_url</code>/<code>cron_secret</code> i
                Supabase Vault passer med <code>CRON_SECRET</code>.
              </div>
            )}
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-neutral-500">Sidste vellykkede</dt>
                <dd className="font-medium text-neutral-900">{siden(rute.data.sidsteOk, nu)}</dd>
                <dd className="text-xs text-neutral-500">{tid(rute.data.sidsteOk)}</dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-500">Kørsler sidste 24 t</dt>
                <dd className="font-medium text-neutral-900">{rute.data.koersler24t}</dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-500">Fejl sidste 24 t</dt>
                <dd className={`font-medium ${rute.data.fejl24t > 0 ? "text-red-700" : "text-neutral-900"}`}>
                  {rute.data.fejl24t}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-neutral-500">pg_net-svar med fejl</dt>
                <dd className={`font-medium ${httpFejl.length > 0 ? "text-red-700" : "text-neutral-900"}`}>
                  {http.tilstand === "ok" ? `${httpFejl.length} af ${http.data.length}` : "—"}
                </dd>
              </div>
            </dl>
            {http.tilstand !== "ok" && <SektionFejl s={http} />}

            {rute.data.seneste.length === 0 ? (
              !ruteIkkeKaldtPaaTest && <p className="text-sm text-neutral-500">Ingen kørsler logget endnu.</p>
            ) : (
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="bg-neutral-50 text-xs uppercase text-neutral-500">
                      <th className={th}>Start</th>
                      <th className={th}>Varighed</th>
                      <th className={th}>Kald</th>
                      <th className={th}>Status</th>
                      <th className={th}>Fejl</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {rute.data.seneste.map((k) => (
                      <tr key={k.id}>
                        <td className={`${td} whitespace-nowrap`}>{tid(k.startet_kl)}</td>
                        <td className={`${td} whitespace-nowrap text-neutral-600`}>
                          {varighed(k.startet_kl, k.afsluttet_kl)}
                        </td>
                        <td className={`${td} text-neutral-600`}>
                          {k.metode === "GET" ? "Vercel" : k.metode === "POST" ? "pg_cron" : "—"}
                        </td>
                        <td className={td}>
                          {k.ok === true ? (
                            <Badge farve="groen">OK</Badge>
                          ) : k.ok === false ? (
                            <Badge farve="roed">Fejl</Badge>
                          ) : (
                            <Badge farve="gul">Ikke afsluttet</Badge>
                          )}
                        </td>
                        <td className={`${td} break-words text-neutral-700`}>{k.fejl ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {httpFejl.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-neutral-800">
                  Fejlede kald fra pg_net (seneste ca. 6 timer)
                </h3>
                <ul className="space-y-1 text-sm">
                  {httpFejl.slice(0, 10).map((h) => (
                    <li key={h.id} className="flex flex-wrap gap-x-3 text-neutral-700">
                      <span className="whitespace-nowrap">{tid(h.oprettet_kl)}</span>
                      <span className="font-medium">
                        {h.timed_out ? "Timeout" : h.status_code ? `HTTP ${h.status_code}` : "Intet svar"}
                      </span>
                      {h.fejl && <span className="break-words text-neutral-500">{h.fejl}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Kort>

      <Kort titel="pg_cron-jobs (databasen)">
        <SektionFejl s={pgCron} />
        {pgCron.tilstand === "ok" &&
          (pgCron.data.length === 0 ? (
            <p className="text-sm text-neutral-500">Ingen jobs fundet (pg_cron er ikke slået til).</p>
          ) : (
            <div className="-mx-4 overflow-x-auto sm:mx-0">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="bg-neutral-50 text-xs uppercase text-neutral-500">
                    <th className={th}>Job</th>
                    <th className={th}>Tidsplan</th>
                    <th className={th}>Sidste kørsel</th>
                    <th className={th}>Status</th>
                    <th className={th}>Fejl 24 t</th>
                    <th className={th}>Seneste fejl</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {pgCron.data.map((j) => (
                    <tr key={j.jobid}>
                      <td className={`${td} font-medium text-neutral-900`}>
                        {j.jobname ?? `#${j.jobid}`}
                        {!j.active && (
                          <span className="ml-2">
                            <Badge farve="gul">Slået fra</Badge>
                          </span>
                        )}
                      </td>
                      <td className={`${td} whitespace-nowrap font-mono text-xs text-neutral-600`}>{j.schedule}</td>
                      <td className={`${td} whitespace-nowrap`}>
                        {tid(j.sidste_start)}
                        <span className="block text-xs text-neutral-500">{siden(j.sidste_start, nu)}</span>
                      </td>
                      <td className={td}>
                        {j.sidste_status === "succeeded" ? (
                          <Badge farve="groen">OK</Badge>
                        ) : j.sidste_status === "failed" ? (
                          <Badge farve="roed">Fejl</Badge>
                        ) : j.sidste_status ? (
                          <Badge farve="gul">{j.sidste_status}</Badge>
                        ) : (
                          <Badge farve="graa">Ingen</Badge>
                        )}
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        <span className={j.fejl_24t > 0 ? "font-semibold text-red-700" : ""}>{j.fejl_24t}</span>
                        <span className="text-neutral-500"> / {j.koersler_24t}</span>
                      </td>
                      <td className={`${td} break-words text-neutral-700`}>
                        {j.seneste_fejl_kl ? (
                          // Fremhæv kun fejlen, hvis den er aktuel: fra de sidste 24 t,
                          // eller jobbets sidste kørsel fejlede (fx et dagligt job).
                          nu - new Date(j.seneste_fejl_kl).getTime() <= 24 * 60 * 60_000 ||
                          j.sidste_status === "failed" ? (
                            <>
                              <span className="block text-xs text-neutral-500">{tid(j.seneste_fejl_kl)}</span>
                              <span className="text-red-700">{j.seneste_fejl}</span>
                            </>
                          ) : (
                            <span
                              className="text-xs text-neutral-400"
                              title={`${tid(j.seneste_fejl_kl)}: ${j.seneste_fejl ?? ""}`}
                            >
                              Seneste fejl for {siden(j.seneste_fejl_kl, nu)} (løst siden)
                            </span>
                          )
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Kort>

      {/* ---------------------------------------------------------- Notifikationer */}
      <Kort
        titel="Notifikationer der ikke er sendt (7 dage)"
        hoejre={
          ikkeSendte.tilstand === "ok" ? (
            <Badge farve={ikkeSendte.data.length > 0 ? "roed" : "groen"}>{ikkeSendte.data.length}</Badge>
          ) : null
        }
      >
        <SektionFejl s={ikkeSendte} />
        {ikkeSendte.tilstand === "ok" &&
          (ikkeSendte.data.length === 0 ? (
            <p className="text-sm text-neutral-500">Ingen fejlede eller hængende notifikationer.</p>
          ) : (
            <>
              <p className="mb-3 text-xs text-neutral-500">
                Fejlede kanaler og afsendelser, der er claimet, men ikke meldt færdige efter{" "}
                {CLAIM_HAENGER_MIN} minutter. Intet indhold vises.
              </p>
              <div className="-mx-4 overflow-x-auto sm:mx-0">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="bg-neutral-50 text-xs uppercase text-neutral-500">
                      <th className={th}>Tid</th>
                      <th className={th}>Type</th>
                      <th className={th}>Kanal</th>
                      <th className={th}>Status</th>
                      <th className={th}>Modtager</th>
                      <th className={th}>Fejl</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {ikkeSendte.data.map((r) => (
                      <tr key={r.noegle}>
                        <td className={`${td} whitespace-nowrap`}>{tid(r.tid)}</td>
                        <td className={`${td} font-mono text-xs`}>{r.type}</td>
                        <td className={td}>{r.kanal}</td>
                        <td className={td}>
                          {r.status === "haenger" ? (
                            <Badge farve="gul">Ikke sendt</Badge>
                          ) : r.status === "delvis" ? (
                            <Badge farve="gul">Delvis</Badge>
                          ) : (
                            <Badge farve="roed">Fejlet</Badge>
                          )}
                        </td>
                        <td className={td}>
                          {r.brugerId ? (
                            <Link href={`/admin/brugere/${r.brugerId}`} className="block hover:underline">
                              <span className="block text-neutral-800">{r.email}</span>
                              <span className="block font-mono text-[11px] text-neutral-500">
                                {r.brugerId.slice(0, 8)}
                              </span>
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className={`${td} break-words text-neutral-700`}>{r.fejl ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ))}
      </Kort>

      {/* ---------------------------------------------------------- Fejl */}
      <Kort
        titel={`Fejl på siden (${dage === 1 ? "1 dag" : `${dage} dage`})`}
        hoejre={
          <nav className="flex gap-1" aria-label="Periode">
            {DAGE_VALG.map((d) => (
              <Link
                key={d}
                href={`/admin/drift?dage=${d}`}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  d === dage ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
                }`}
                aria-current={d === dage ? "page" : undefined}
              >
                {d === 1 ? "1 dag" : `${d} dage`}
              </Link>
            ))}
          </nav>
        }
      >
        <SektionFejl s={fejl} />
        {fejl.tilstand === "ok" &&
          (fejl.data.grupper.length === 0 ? (
            <p className="text-sm text-neutral-500">Ingen fejl registreret i perioden.</p>
          ) : (
            <>
              <p className="mb-3 text-xs text-neutral-500">
                {fejl.data.iAlt} registreringer i {fejl.data.grupper.length}{" "}
                {fejl.data.grupper.length === 1 ? "gruppe" : "grupper"}, grupperet pr. besked. Samme fejl
                (samme fejlkode) tælles op i stedet for at blive gentaget.
                {fejl.data.afkortet && " Kun de seneste 1000 rækker er medtaget."}
              </p>
              <ul className="divide-y divide-neutral-100">
                {fejl.data.grupper.map((g) => (
                  <li key={g.noegle} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-start gap-2">
                      <Badge farve={g.kilde === "klient" ? "graa" : "roed"}>{KILDE[g.kilde] ?? g.kilde}</Badge>
                      <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-xs font-bold text-white">
                        {g.antal}×
                      </span>
                      <p className="min-w-0 flex-1 break-words text-sm font-medium text-neutral-900">{g.besked}</p>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
                      <span>Senest {tid(g.senest)}</span>
                      <span>Først {tid(g.foerst)}</span>
                      {g.brugere > 0 && <span>{g.brugere} {g.brugere === 1 ? "bruger" : "brugere"}</span>}
                      {g.stier.length > 0 && (
                        <span className="break-all font-mono">{g.stier.join(", ")}</span>
                      )}
                      {g.digests.length > 0 && (
                        <span className="font-mono">Fejlkode {g.digests.join(", ")}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ))}
      </Kort>

      <p className="text-xs text-neutral-400">
        Driftsdata slettes automatisk efter 90 dage. Fejlteksterne er renset for e-mails, telefonnumre og
        nøgler.
      </p>
    </div>
  );
}
