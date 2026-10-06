import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentBetalingsindstillinger, hentMineOverfoersler } from "@/app/actions/betaling";
import KontoBetaling from "@/components/betaling/KontoBetaling";
import KontoUdbetaling from "@/components/betaling/KontoUdbetaling";
import BlokeredeBrugere, { type Blokering } from "@/components/tryghed/BlokeredeBrugere";
import {
  DineDataSektion,
  KontoNavigation,
  ProfilSektion,
  SikkerhedSektion,
} from "@/components/konto/KontoSektioner";
import Ikon, { type IkonNavn } from "@/components/Ikon";
import { harToTrin } from "@/lib/mfa";

export const dynamic = "force-dynamic";

type MinAdvarsel = { id: string; begrundelse_bruger: string | null; oprettet_kl: string };
type MinPaamindelse = { id: string; grund: string; begrundelse_bruger: string; oprettet_kl: string };

const GRUND_NAVN: Record<string, string> = { daarlig_indpakning: "Dårlig indpakning" };

const OVERBLIK: { href: string; ikon: IkonNavn; titel: string; tekst: string }[] = [
  { href: "/konto/statistik", ikon: "statistik", titel: "Min statistik", tekst: "Salg, indtjening og dine bud" },
  { href: "/konto/foelger", ikon: "foelgere", titel: "Sælgere du følger", tekst: "Få besked om nye varer" },
  { href: "/konto/soegninger", ikon: "soeg", titel: "Gemte søgninger", tekst: "Besked, når der kommer nyt" },
];

function datoTekst(iso: string) {
  return new Date(iso).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Copenhagen",
  });
}

export const metadata: Metadata = { title: "Min konto", robots: { index: false, follow: false } };

export default async function KontoSide({
  searchParams,
}: {
  searchParams: Promise<{ stripe?: string; setup_intent?: string; data?: string; sikkerhed?: string }>;
}) {
  const { stripe, setup_intent, data: dataStatus, sikkerhed } = await searchParams;
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
    overfoerslerSvar,
    { data: advarselData, error: advarselFejl },
    { data: paamindelseData, error: paamindelseFejl },
    { data: blokeringData, error: blokeringFejl },
  ] = await Promise.all([
    hentBetalingsindstillinger(),
    hentMineOverfoersler(),
    supabase.rpc("mine_advarsler"),
    supabase.rpc("mine_paamindelser"),
    // Anonyme spærringer af bydere returneres uden navn og bruger-id.
    supabase.rpc("mine_blokeringer"),
  ]);
  if (blokeringFejl) console.error("Konto: blokeringer kunne ikke hentes:", blokeringFejl.message);
  const blokeringer: Blokering[] = (
    (blokeringData ?? []) as {
      id: string;
      bruger_id: string | null;
      navn: string | null;
      auktion_id: string | null;
      auktion_titel: string | null;
      oprettet_kl: string;
    }[]
  ).map((b) => ({
    id: b.id,
    brugerId: b.bruger_id,
    navn: b.navn,
    auktionId: b.auktion_id,
    auktionTitel: b.auktion_titel,
    oprettetKl: b.oprettet_kl,
  }));
  if (advarselFejl) console.error("Konto: advarsler kunne ikke hentes:", advarselFejl.message);
  if (paamindelseFejl) console.error("Konto: påmindelser kunne ikke hentes:", paamindelseFejl.message);
  const advarsler = (advarselData ?? []) as MinAdvarsel[];
  const paamindelser = (paamindelseData ?? []) as MinPaamindelse[];

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <h1 className="text-[26px] leading-tight sm:text-[32px]">Min konto</h1>
      <KontoNavigation />
      {/* Sendt hertil fra admin (src/lib/adminAuth.ts): medarbejdere uden to-trins-login. */}
      {sikkerhed === "to-trin-paakraevet" && !harToTrin(authData.user) && (
        <p
          role="alert"
          className="mt-6 rounded-xl border border-advarsel-kant bg-advarsel-bg p-4 text-sm text-advarsel-tekst"
        >
          <strong className="font-semibold">Medarbejdere skal bruge to-trins-login.</strong> Slå det til
          under <a href="#sikkerhed" className="font-semibold underline">Sikkerhed</a>. Når det er slået til, kan du åbne admin igen.
        </p>
      )}

      {advarsler.length > 0 && (
        <section
          id="advarsler"
          className="mt-6 scroll-mt-24 rounded-[14px] border border-advarsel-kant bg-advarsel-bg p-5 sm:p-6"
        >
          <h2 className="text-[20px] leading-tight text-advarsel-tekst lg:text-[22px]">
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
          className="mt-6 scroll-mt-24 rounded-[14px] border border-kant bg-white p-5 sm:p-6"
        >
          <h2 className="text-[20px] leading-tight lg:text-[22px]">
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

      <nav aria-label="Dit overblik" className="mt-6">
        <ul className="grid gap-3 sm:grid-cols-3">
          {OVERBLIK.map((o) => (
            <li key={o.href}>
              <Link
                href={o.href}
                className="flex h-full min-h-11 items-start gap-3 rounded-[14px] border border-kant bg-white p-4 hover:border-kant-staerk hover:shadow-[0_8px_24px_rgba(0,0,0,.10)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
              >
                <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg bg-groen-lys text-groen-mork">
                  <Ikon navn={o.ikon} className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold text-tekst">{o.titel}</span>
                  <span className="mt-0.5 block text-[13px] text-tekst-daempet">{o.tekst}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <ProfilSektion bruger={authData.user} />
      <SikkerhedSektion bruger={authData.user} />

      {"fejl" in indstillinger ? (
        <p
          role="alert"
          className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst"
        >
          Dine betalingsindstillinger kunne ikke hentes. {indstillinger.fejl}
        </p>
      ) : (
        <>
          <section id="betaling" className="mt-6 scroll-mt-24 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 className="text-[20px] leading-tight lg:text-[22px]">Betaling</h2>
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

          <section id="udbetaling" className="mt-6 scroll-mt-24 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 className="text-[20px] leading-tight lg:text-[22px]">Udbetaling</h2>
            <div className="mt-3">
              <KontoUdbetaling
                saelger={indstillinger.saelger}
                erRetur={stripe === "retur"}
                overfoersler={"fejl" in overfoerslerSvar ? null : overfoerslerSvar.overfoersler}
              />
            </div>
          </section>
        </>
      )}

      <section id="notifikationer" className="mt-6 scroll-mt-24 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
        <h2 className="text-[20px] leading-tight lg:text-[22px]">Notifikationer</h2>
        <p className="mt-1 text-sm text-tekst-daempet">
          Vælg, hvilke beskeder du vil have i klokken, på mail og i appen.
        </p>
        <Link href="/konto/notifikationer" className="btn btn-sekundaer mt-4">
          Notifikationsindstillinger
        </Link>
      </section>

      <section id="afgoerelser" className="mt-6 scroll-mt-24 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
        <h2 className="text-[20px] leading-tight lg:text-[22px]">Afgørelser og anmeldelser</h2>
        <p className="mt-1 text-sm text-tekst-daempet">
          Se, hvis BidHamr har fjernet eller begrænset noget af dit indhold, og klag, hvis du er uenig. Her kan du også
          følge det, du selv har anmeldt.
        </p>
        <Link href="/konto/afgoerelser" className="btn btn-sekundaer mt-4">
          Se afgørelser og anmeldelser
        </Link>
      </section>

      <section id="blokerede" className="mt-6 scroll-mt-24 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
        <h2 className="text-[20px] leading-tight lg:text-[22px]">Blokerede brugere</h2>
        <p className="mt-1 text-sm text-tekst-daempet">
          Blokerede brugere kan ikke byde på dine auktioner, skrive til dig eller stille dig spørgsmål.
          Handler, I allerede er i gang med, kan stadig gennemføres.
        </p>
        <div className="mt-3">
          {blokeringFejl ? (
            <p role="alert" className="text-sm text-fejl-tekst">
              Listen kunne ikke hentes lige nu. Prøv igen om lidt.
            </p>
          ) : (
            <BlokeredeBrugere blokeringer={blokeringer} />
          )}
        </div>
      </section>

      <DineDataSektion dataStatus={dataStatus} />

      <p className="mt-6 text-sm text-tekst-daempet">
        Se dine køb og salg under{" "}
        <Link href="/mine-handler" className="font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
          Mine handler
        </Link>
        .
      </p>
    </main>
  );
}
