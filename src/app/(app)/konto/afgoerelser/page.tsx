import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import KontoSideHoved from "@/components/konto/KontoSideHoved";
import { HANDLING_BRUGER, UDFALD_NAVNE, anmeldKategoriNavn, indholdNavn, nuMs, type DsaHandling } from "@/lib/dsa/regler";

// Brugerens egne DSA-sager: afgørelser om brugerens indhold/konto (med
// klagemulighed) og de anmeldelser, brugeren selv har lavet.
// mine_dsa_afgoerelser() / mine_dsa_anmeldelser() udleder brugeren af auth.uid().

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Afgørelser og anmeldelser", robots: { index: false, follow: false } };

type MinAfg = {
  id: string;
  sagsnummer: string;
  handling: DsaHandling;
  indhold_tekst: string | null;
  oprettet_kl: string;
  klage_frist_kl: string;
  ophaevet_kl: string | null;
  klage_status: string | null;
  klage_udfald: string | null;
};

type MinAnm = {
  id: string;
  sagsnummer: string;
  indhold_type: string;
  kategori: string;
  status: string;
  udfald: string | null;
  oprettet_kl: string;
  behandlet_kl: string | null;
  klage_status: string | null;
};

type Filter = "alle" | "kan-klage" | "under-klage" | "ophaevet";
const FILTRE: { id: Filter; label: string }[] = [
  { id: "alle", label: "Alle" },
  { id: "kan-klage", label: "Kan klages" },
  { id: "under-klage", label: "Under klage" },
  { id: "ophaevet", label: "Ophævet" },
];
const KLAGE_DAGE = 182;

const dato = (iso: string) =>
  new Date(iso).toLocaleDateString("da-DK", { timeZone: "Europe/Copenhagen", day: "numeric", month: "long", year: "numeric" });

function Maerke({ children, tone }: { children: React.ReactNode; tone: "neutral" | "god" | "advarsel" }) {
  const k =
    tone === "god"
      ? "bg-succes-bg text-succes-tekst"
      : tone === "advarsel"
        ? "bg-advarsel-bg text-advarsel-tekst"
        : "bg-groen-lys text-groen-mork";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${k}`}>{children}</span>;
}

export default async function AfgoerelserSide({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: raaFilter } = await searchParams;
  const filter: Filter = FILTRE.some((f) => f.id === raaFilter) ? (raaFilter as Filter) : "alle";
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/konto/afgoerelser");

  const [{ data: afgData, error: afgFejl }, { data: anmData, error: anmFejl }] = await Promise.all([
    supabase.rpc("mine_dsa_afgoerelser"),
    supabase.rpc("mine_dsa_anmeldelser"),
  ]);
  if (afgFejl) console.error("Afgørelser kunne ikke hentes:", afgFejl.message);
  if (anmFejl) console.error("Anmeldelser kunne ikke hentes:", anmFejl.message);
  const alleAfg = (afgData ?? []) as MinAfg[];
  const alleAnm = (anmData ?? []) as MinAnm[];
  const nu = nuMs();

  const afgKanKlage = (a: MinAfg) => !a.klage_status && !a.ophaevet_kl && new Date(a.klage_frist_kl).getTime() > nu;
  const anmKanKlage = (a: MinAnm) =>
    a.status === "afgjort" &&
    a.udfald !== "indgreb" &&
    !a.klage_status &&
    !!a.behandlet_kl &&
    nu < new Date(a.behandlet_kl).getTime() + KLAGE_DAGE * 24 * 3600 * 1000;
  const afgPasser = (a: MinAfg, f: Filter) =>
    f === "alle" ||
    (f === "kan-klage" && afgKanKlage(a)) ||
    (f === "under-klage" && a.klage_status === "afventer") ||
    (f === "ophaevet" && !!a.ophaevet_kl);
  const anmPasser = (a: MinAnm, f: Filter) =>
    f === "alle" || (f === "kan-klage" && anmKanKlage(a)) || (f === "under-klage" && a.klage_status === "afventer");
  const antal = (f: Filter) => alleAfg.filter((a) => afgPasser(a, f)).length + alleAnm.filter((a) => anmPasser(a, f)).length;

  const afg = alleAfg.filter((a) => afgPasser(a, filter));
  const anm = alleAnm.filter((a) => anmPasser(a, filter));
  const filtreret = filter !== "alle";

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <KontoSideHoved
        titel="Afgørelser og anmeldelser"
        krumme="Afgørelser"
        tekst="Her kan du se, hvis BidHamr har fjernet eller begrænset noget af dit indhold, og hvorfor – og klage, hvis du er uenig. Du kan også følge de anmeldelser, du selv har lavet."
      />

      {(afgFejl || anmFejl) && (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Listen kunne ikke hentes lige nu. Prøv igen om lidt.
        </p>
      )}

      <nav aria-label="Filtrér sager" className="mt-6">
        <ul className="flex flex-wrap gap-2">
          {FILTRE.map((f) => {
            const aktiv = filter === f.id;
            return (
              <li key={f.id}>
                <Link
                  href={f.id === "alle" ? "/konto/afgoerelser" : `/konto/afgoerelser?filter=${f.id}`}
                  aria-current={aktiv ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                    aktiv ? "border-groen bg-groen text-white" : "border-kant-staerk bg-white text-tekst hover:bg-groen-lys"
                  }`}
                >
                  {f.label}
                  <span className={aktiv ? "text-white/85" : "text-tekst-svag"}>({antal(f.id)})</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {filtreret && afg.length === 0 && anm.length === 0 && (
        <p className="mt-6 rounded-[14px] border border-kant bg-white p-6 text-center text-[15px] text-tekst-daempet">
          Ingen sager passer til filteret.{" "}
          <Link href="/konto/afgoerelser" className="font-medium text-groen hover:underline">
            Vis alle
          </Link>
        </p>
      )}

      {(!filtreret || afg.length > 0) && (
        <section className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6" aria-labelledby="afg-titel">
          <h2 id="afg-titel" className="text-[20px] leading-tight">Afgørelser om dig</h2>
          {afg.length === 0 ? (
            <p className="mt-2 text-sm text-tekst-svag">BidHamr har ikke fjernet eller begrænset noget af dit indhold.</p>
          ) : (
            <ul className="mt-3 divide-y divide-kant">
              {afg.map((a) => {
                const kanKlage = afgKanKlage(a);
                return (
                  <li key={a.id} className="py-3">
                    <Link
                      href={`/dsa/afgoerelse/${a.id}`}
                      className="flex flex-col gap-1 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:justify-between"
                    >
                      <span className="min-w-0">
                        <span className="block font-medium text-tekst hover:text-groen">{HANDLING_BRUGER[a.handling] ?? a.handling}</span>
                        <span className="block truncate text-sm text-tekst-svag">
                          {a.sagsnummer} · {dato(a.oprettet_kl)}
                          {a.indhold_tekst ? ` · ${a.indhold_tekst}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0">
                        {a.ophaevet_kl ? (
                          <Maerke tone="god">Ophævet</Maerke>
                        ) : a.klage_status === "afventer" ? (
                          <Maerke tone="neutral">Klage behandles</Maerke>
                        ) : a.klage_udfald ? (
                          <Maerke tone={a.klage_udfald === "medhold" ? "god" : "neutral"}>
                            {a.klage_udfald === "medhold" ? "Medhold" : "Klage afgjort"}
                          </Maerke>
                        ) : kanKlage ? (
                          <Maerke tone="advarsel">Du kan klage</Maerke>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {(!filtreret || anm.length > 0) && (
        <section className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6" aria-labelledby="anm-titel">
          <h2 id="anm-titel" className="text-[20px] leading-tight">Dine anmeldelser</h2>
          {anm.length === 0 ? (
            <p className="mt-2 text-sm text-tekst-svag">
              Du har ikke anmeldt noget.{" "}
              <Link href="/dsa/anmeld" className="font-medium text-groen hover:underline">
                Anmeld ulovligt indhold
              </Link>
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-kant">
              {anm.map((a) => (
                <li key={a.id} className="py-3">
                  <Link
                    href={`/dsa/anmeldelse/${a.id}`}
                    className="flex flex-col gap-1 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium text-tekst hover:text-groen">
                        {indholdNavn(a.indhold_type)} · {anmeldKategoriNavn(a.kategori)}
                      </span>
                      <span className="block text-sm text-tekst-svag">
                        {a.sagsnummer} · {dato(a.oprettet_kl)}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-wrap gap-1.5">
                      {a.status === "ny" ? (
                        <Maerke tone="neutral">Behandles</Maerke>
                      ) : (
                        <Maerke tone={a.udfald === "indgreb" ? "god" : "neutral"}>
                          {UDFALD_NAVNE[a.udfald ?? ""]?.split(" – ")[0] ?? "Afgjort"}
                        </Maerke>
                      )}
                      {a.klage_status === "afventer" ? (
                        <Maerke tone="neutral">Klage behandles</Maerke>
                      ) : anmKanKlage(a) ? (
                        <Maerke tone="advarsel">Du kan klage</Maerke>
                      ) : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
