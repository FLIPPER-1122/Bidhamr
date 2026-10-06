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
  klage_status: string | null;
};

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

export default async function AfgoerelserSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/konto/afgoerelser");

  const [{ data: afgData, error: afgFejl }, { data: anmData, error: anmFejl }] = await Promise.all([
    supabase.rpc("mine_dsa_afgoerelser"),
    supabase.rpc("mine_dsa_anmeldelser"),
  ]);
  if (afgFejl) console.error("Afgørelser kunne ikke hentes:", afgFejl.message);
  if (anmFejl) console.error("Anmeldelser kunne ikke hentes:", anmFejl.message);
  const afg = (afgData ?? []) as MinAfg[];
  const anm = (anmData ?? []) as MinAnm[];
  const nu = nuMs();

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

      <section className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6" aria-labelledby="afg-titel">
        <h2 id="afg-titel" className="text-[20px] leading-tight">Afgørelser om dig</h2>
        {afg.length === 0 ? (
          <p className="mt-2 text-sm text-tekst-svag">BidHamr har ikke fjernet eller begrænset noget af dit indhold.</p>
        ) : (
          <ul className="mt-3 divide-y divide-kant">
            {afg.map((a) => {
              const kanKlage = !a.klage_status && !a.ophaevet_kl && new Date(a.klage_frist_kl).getTime() > nu;
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
                  <span className="shrink-0">
                    {a.status === "ny" ? (
                      <Maerke tone="neutral">Behandles</Maerke>
                    ) : (
                      <Maerke tone={a.udfald === "indgreb" ? "god" : "neutral"}>
                        {UDFALD_NAVNE[a.udfald ?? ""]?.split(" – ")[0] ?? "Afgjort"}
                      </Maerke>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
