import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { bekraeftetBruger, hentBruger, sessionBrugerId } from "@/lib/supabase/bruger";
import { hentBetalingsindstillinger, hentMineBankudbetalinger } from "@/app/actions/betaling";
import KontoBetaling from "@/components/betaling/KontoBetaling";
import KontoUdbetaling from "@/components/betaling/KontoUdbetaling";
import BlokeredeBrugere, { type Blokering } from "@/components/tryghed/BlokeredeBrugere";
import {
  DineDataSektion,
  forhaandshentKonto,
  KontoNavigation,
  ProfilSektion,
  SikkerhedSektion,
} from "@/components/konto/KontoSektioner";
import Ikon, { type IkonNavn } from "@/components/Ikon";
import MitIDMaerke from "@/components/mitid/MitIDMaerke";
import { MitIDIkon, MitIDKnap } from "@/components/mitid/MitIDKraeves";
import { MITID } from "@/lib/tekster/mitid";

export const dynamic = "force-dynamic";

type MinAdvarsel = { id: string; begrundelse_bruger: string | null; oprettet_kl: string };
type MinPaamindelse = { id: string; grund: string; begrundelse_bruger: string; oprettet_kl: string };

const GRUND_NAVN: Record<string, string> = { daarlig_indpakning: "Dårlig indpakning" };

const OVERBLIK: { href: string; ikon: IkonNavn; titel: string; tekst: string }[] = [
  { href: "/konto/statistik", ikon: "statistik", titel: "Min statistik", tekst: "Salg, indtjening og dine bud" },
  { href: "/konto/foelger", ikon: "foelgere", titel: "Sælgere du følger", tekst: "Få besked om nye varer" },
  { href: "/konto/soegninger", ikon: "soeg", titel: "Gemte søgninger", tekst: "Besked, når der kommer nyt" },
  { href: "/konto/fakturaer", ikon: "handler", titel: "Fakturaer", tekst: "Fakturaer fra BidHamr på gebyrer" },
  { href: "/konto/skat", ikon: "laas", titel: "Skatteoplysninger", tekst: "Indberetning til Skattestyrelsen (DAC7)" },
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
  searchParams: Promise<{ stripe?: string; setup_intent?: string; data?: string }>;
}) {
  const { stripe, setup_intent, data: dataStatus } = await searchParams;
  const supabase = await createClient();

  // Alle opslag herunder hentes SAMTIDIG med valideringen af brugeren (før:
  // først getUser, så resten). De udleder selv brugeren af auth.uid() i
  // JWT'en eller tjekker login selv, og intet vises, før getUser har godkendt
  // brugeren. Profil-sektionernes navn og enheder startes også nu (med id'et
  // fra sessionens JWT - bruges kun, hvis det er den bekræftede bruger).
  const sessionId = await sessionBrugerId();
  if (sessionId) forhaandshentKonto(sessionId);

  // Brugerens egne advarsler: kun begrundelse til brugeren og dato
  // (mine_advarsler() udleder brugeren af auth.uid(); den interne note
  // kan ikke læses herfra).
  // Påmindelser (fx 1. gang dårlig indpakning) hentes på samme måde via
  // mine_paamindelser() og tæller ikke med i reglen om 3 advarsler.
  const [
    bruger,
    indstillinger,
    bankudbetalingerSvar,
    { data: advarselData, error: advarselFejl },
    { data: paamindelseData, error: paamindelseFejl },
    { data: blokeringData, error: blokeringFejl },
    { data: mitidData },
    { data: dac7Data },
  ] = await Promise.all([
    sessionId ? bekraeftetBruger(sessionId) : hentBruger(),
    hentBetalingsindstillinger(),
    hentMineBankudbetalinger(),
    supabase.rpc("mine_advarsler"),
    supabase.rpc("mine_paamindelser"),
    // Anonyme spærringer af bydere returneres uden navn og bruger-id.
    supabase.rpc("mine_blokeringer"),
    // Egen MitID-verificering (RLS: kun brugeren selv). Navnet fra MitID
    // vises kun her - aldrig for andre.
    sessionId
      ? supabase
          .from("mitid_verificeringer")
          .select("juridisk_navn, verificeret_kl")
          .eq("bruger_id", sessionId)
          .eq("status", "aktiv")
          .maybeSingle<{ juridisk_navn: string | null; verificeret_kl: string }>()
      : Promise.resolve({ data: null }),
    // DAC7: åben anmodning om skatteoplysninger (kun egne, auth.uid()).
    supabase.rpc("dac7_min_status"),
  ]);
  if (!bruger) {
    redirect("/login?redirect=/konto");
  }
  const authData = { user: bruger };

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
  const dac7Anmodning =
    (dac7Data as { anmodning?: { frist: string; spaerret: boolean } | null } | null)?.anmodning ?? null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <h1 className="text-[26px] leading-tight sm:text-[32px]">Min konto</h1>
      <KontoNavigation />

      {/* Ikke MitID-verificeret: fremtrædende kort øverst (kræves før første
          bud og første auktion). Firmakonti når aldrig hertil (proxyen sender
          dem til /firma). */}
      {!mitidData && (
        <section
          id="mitid"
          aria-labelledby="mitid-kort-titel"
          className="mt-6 scroll-mt-24 rounded-[14px] border border-advarsel-kant bg-advarsel-bg p-5 text-advarsel-tekst sm:p-6"
        >
          <div className="flex items-start gap-3">
            <MitIDIkon />
            <div className="min-w-0">
              <h2 id="mitid-kort-titel" className="text-[20px] leading-tight text-advarsel-tekst lg:text-[22px]">
                {MITID.kontoKortTitel}
              </h2>
              <p className="mt-1 text-[15px]">{MITID.kontoKortTekst}</p>
            </div>
          </div>
          <ul className="mt-4 space-y-1.5 text-sm">
            {MITID.hvorfor.map((h) => (
              <li key={h} className="flex items-start gap-2">
                <Ikon navn="flueben" className="mt-0.5 h-4 w-4 shrink-0" strøg={2.25} />
                <span>{h}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <MitIDKnap retur="/konto#mitid" fuldBredde />
          </div>
        </section>
      )}

      {dac7Anmodning && (
        <section
          id="skat"
          className={`mt-6 scroll-mt-24 rounded-[14px] border p-5 sm:p-6 ${
            dac7Anmodning.spaerret
              ? "border-fejl-kant bg-fejl-bg text-fejl-tekst"
              : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"
          }`}
        >
          <h2 className="text-[20px] leading-tight lg:text-[22px]">Vi mangler dine skatteoplysninger</h2>
          <p className="mt-1 text-sm">
            {dac7Anmodning.spaerret
              ? "Du kan ikke sætte nye varer til salg, før du har udfyldt dem."
              : `Udfyld dem senest ${datoTekst(dac7Anmodning.frist)}.`}
          </p>
          <Link href="/konto/skat" className="btn btn-sekundaer mt-4">
            Udfyld skatteoplysninger
          </Link>
        </section>
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
        <ul className="grid gap-3 sm:grid-cols-2">
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

      {/* Ikke verificeret: kortet står øverst på siden (se ovenfor). */}
      {mitidData && (
        <section id="mitid" className="mt-6 scroll-mt-24 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
          <h2 className="text-[20px] leading-tight lg:text-[22px]">{MITID.kontoTitel}</h2>
          <div className="mt-2 space-y-2 text-sm text-tekst-daempet">
            <MitIDMaerke />
            <p>{MITID.kontoVerificeret(datoTekst(mitidData.verificeret_kl))}</p>
            {mitidData.juridisk_navn && (
              <p>
                {MITID.kontoNavn} <span className="font-medium text-tekst">{mitidData.juridisk_navn}</span>
              </p>
            )}
          </div>
        </section>
      )}

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
                bankudbetalinger={"fejl" in bankudbetalingerSvar ? null : bankudbetalingerSvar.udbetalinger}
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
