import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentBetalingsindstillinger } from "@/app/actions/betaling";
import KontoBetaling from "@/components/betaling/KontoBetaling";
import KontoUdbetaling from "@/components/betaling/KontoUdbetaling";

export const dynamic = "force-dynamic";

type MinAdvarsel = { id: string; begrundelse_bruger: string | null; oprettet_kl: string };
type MinPaamindelse = { id: string; grund: string; begrundelse_bruger: string; oprettet_kl: string };

const GRUND_NAVN: Record<string, string> = { daarlig_indpakning: "Dårlig indpakning" };

function datoTekst(iso: string) {
  return new Date(iso).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Copenhagen",
  });
}

export default async function KontoSide({
  searchParams,
}: {
  searchParams: Promise<{ stripe?: string; setup_intent?: string }>;
}) {
  const { stripe, setup_intent } = await searchParams;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    redirect("/login?redirect=/konto");
  }

  // Brugerens egne advarsler: kun begrundelse til brugeren og dato
  // (mine_advarsler() udleder brugeren af auth.uid(); den interne note
  // kan ikke læses herfra).
  // Påmindelser (fx 1. gang dårlig indpakning) hentes på samme måde via
  // mine_paamindelser() og tæller ikke med i reglen om 3 advarsler.
  const [
    indstillinger,
    { data: advarselData, error: advarselFejl },
    { data: paamindelseData, error: paamindelseFejl },
  ] = await Promise.all([
    hentBetalingsindstillinger(),
    supabase.rpc("mine_advarsler"),
    supabase.rpc("mine_paamindelser"),
  ]);
  if (advarselFejl) console.error("Konto: advarsler kunne ikke hentes:", advarselFejl.message);
  if (paamindelseFejl) console.error("Konto: påmindelser kunne ikke hentes:", paamindelseFejl.message);
  const advarsler = (advarselData ?? []) as MinAdvarsel[];
  const paamindelser = (paamindelseData ?? []) as MinPaamindelse[];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="font-serif text-3xl font-semibold text-tekst">Min konto</h1>

      {advarsler.length > 0 && (
        <section
          id="advarsler"
          className="mt-6 scroll-mt-24 rounded-2xl border border-advarsel-kant bg-advarsel-bg p-5 sm:p-6"
        >
          <h2 className="font-serif text-xl font-semibold text-advarsel-tekst">
            Advarsler ({advarsler.length})
          </h2>
          <p className="mt-1 text-sm text-advarsel-tekst">
            Du har fået {advarsler.length === 1 ? "1 advarsel" : `${advarsler.length} advarsler`}.
            Efter 3 advarsler kan din profil blive lukket permanent. Kontakt support@bidhamr.dk, hvis
            du har spørgsmål.
          </p>
          <ul className="mt-4 space-y-3">
            {advarsler.map((a) => (
              <li key={a.id} className="rounded-xl border border-advarsel-kant bg-white p-4">
                <p className="text-xs font-medium text-tekst-daempet">{datoTekst(a.oprettet_kl)}</p>
                <p className="mt-1 whitespace-pre-line text-sm text-tekst">
                  {a.begrundelse_bruger ?? "Der er ikke angivet en begrundelse for denne advarsel."}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {paamindelser.length > 0 && (
        <section
          id="paamindelser"
          className="mt-6 scroll-mt-24 rounded-2xl border border-kant bg-white p-5 sm:p-6"
        >
          <h2 className="font-serif text-xl font-semibold text-tekst">
            Påmindelser ({paamindelser.length})
          </h2>
          <p className="mt-1 text-sm text-tekst-daempet">
            En påmindelse er ikke en advarsel og tæller ikke med i reglen om 3 advarsler. Næste gang det
            samme sker, giver det en advarsel.
          </p>
          <ul className="mt-4 space-y-3">
            {paamindelser.map((p) => (
              <li key={p.id} className="rounded-xl border border-kant p-4">
                <p className="text-xs font-medium text-tekst-daempet">
                  {datoTekst(p.oprettet_kl)}
                  {GRUND_NAVN[p.grund] ? ` · ${GRUND_NAVN[p.grund]}` : ""}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm text-tekst">{p.begrundelse_bruger}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {"fejl" in indstillinger ? (
        <p
          role="alert"
          className="mt-6 rounded-xl border border-[#F3C4C4] bg-[#FDECEC] p-4 text-sm text-[#A32020]"
        >
          Dine betalingsindstillinger kunne ikke hentes. {indstillinger.fejl}
        </p>
      ) : (
        <>
          <section className="mt-6 rounded-2xl border border-kant bg-white p-5 sm:p-6">
            <h2 className="font-serif text-xl font-semibold text-tekst">Betaling</h2>
            <div className="mt-3">
              <KontoBetaling
                gemtKort={indstillinger.gemtKort}
                autobetaling={indstillinger.autobetaling}
                setupIntentId={
                  setup_intent?.startsWith("seti_") ? setup_intent : null
                }
              />
            </div>
          </section>

          <section className="mt-6 rounded-2xl border border-kant bg-white p-5 sm:p-6">
            <h2 className="font-serif text-xl font-semibold text-tekst">Udbetaling</h2>
            <div className="mt-3">
              <KontoUdbetaling
                saelger={indstillinger.saelger}
                erRetur={stripe === "retur"}
              />
            </div>
          </section>
        </>
      )}

      <section className="mt-6 rounded-2xl border border-kant bg-white p-5 sm:p-6">
        <h2 className="font-serif text-xl font-semibold text-tekst">Notifikationer</h2>
        <p className="mt-1 text-sm text-tekst-daempet">
          Vælg, hvilke beskeder du vil have i klokken, på mail og i appen.
        </p>
        <Link href="/konto/notifikationer" className="btn btn-sekundaer mt-4">
          Notifikationsindstillinger
        </Link>
      </section>

      <p className="mt-6 text-sm text-tekst-daempet">
        Se dine køb og salg under{" "}
        <Link href="/mine-handler" className="font-medium text-groen hover:underline">
          Mine handler
        </Link>
        .
      </p>
    </main>
  );
}
