import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { nuvaerendeEnhedHash } from "@/lib/enheder";
import { BETINGELSER_STI, PRIVATLIV_STI } from "@/lib/vilkaar";
import SkiftAdgangskode from "./SkiftAdgangskode";
import Enheder, { type Enhed } from "./Enheder";
import { FORMULAR_FEJL, KORT, LINK } from "./felter";

// Sektionerne "Profil", "Sikkerhed" og "Dine data" på /konto. Ligger i egne
// komponenter, så konto-siden kun skal importere dem.

const H2 = "text-[20px] leading-tight lg:text-[22px]";
const H3 = "text-[17px] leading-snug lg:text-[18px]";

// Genveje øverst på /konto. Ankrene findes på siden.
export function KontoNavigation() {
  const punkter: [string, string][] = [
    ["#profil", "Profil"],
    ["#sikkerhed", "Sikkerhed"],
    ["#betaling", "Betaling"],
    ["#udbetaling", "Udbetaling"],
    ["#notifikationer", "Notifikationer"],
    ["#blokerede", "Blokerede"],
    ["#dine-data", "Dine data"],
  ];
  return (
    <nav
      aria-label="Sektioner på Min konto"
      className="-mx-4 mt-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      <ul className="flex gap-2 whitespace-nowrap pb-1">
        {punkter.map(([href, tekst]) => (
          <li key={href}>
            <a
              href={href}
              className="inline-flex min-h-11 items-center rounded-full bg-groen-lys px-4 text-[13px] font-medium text-groen-mork hover:bg-[#DCEAE4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              {tekst}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export async function ProfilSektion({ bruger }: { bruger: User }) {
  const supabase = await createClient();
  const { data: profil } = await supabase
    .from("users")
    .select("navn")
    .eq("id", bruger.id)
    .maybeSingle();

  return (
    <section id="profil" className={`mt-6 scroll-mt-24 ${KORT}`}>
      <h2 className={H2}>Profil</h2>
      <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-[140px_1fr]">
        <dt className="text-tekst-daempet">Navn</dt>
        <dd className="font-medium text-tekst">{profil?.navn ?? "—"}</dd>
        <dt className="text-tekst-daempet">E-mail</dt>
        <dd className="min-w-0 break-all font-medium text-tekst">
          {bruger.email}
          {bruger.email_confirmed_at && (
            <span className="ml-2 inline-block rounded-full bg-succes-bg px-2 py-0.5 text-[12px] font-semibold text-succes-tekst">
              Bekræftet
            </span>
          )}
        </dd>
      </dl>
      <Link href={`/profil/${bruger.id}?fane=indstillinger`} className="btn btn-sekundaer mt-4 w-full sm:w-auto">
        Ret navn, telefon og profilbillede
      </Link>
    </section>
  );
}

export async function SikkerhedSektion({ bruger }: { bruger: User }) {
  const supabase = await createClient();
  const hash = await nuvaerendeEnhedHash();
  const [{ data: profil }, { data: enhedData, error: enhedFejl }] = await Promise.all([
    supabase.from("users").select("navn").eq("id", bruger.id).maybeSingle(),
    supabase.rpc("mine_enheder", { p_hash: hash }),
  ]);
  if (enhedFejl) console.error("Konto: enheder kunne ikke hentes:", enhedFejl.message);

  const enheder: Enhed[] = (
    (enhedData ?? []) as {
      id: string;
      beskrivelse: string;
      foerst_set_kl: string;
      sidst_set_kl: string;
      denne: boolean;
      logget_ind: boolean;
    }[]
  ).map((e) => ({
    id: e.id,
    beskrivelse: e.beskrivelse,
    foerstSetKl: e.foerst_set_kl,
    sidstSetKl: e.sidst_set_kl,
    denne: e.denne,
    loggetInd: e.logget_ind,
  }));

  return (
    <section id="sikkerhed" className={`mt-6 scroll-mt-24 ${KORT}`}>
      <h2 className={H2}>Sikkerhed</h2>
      <p className="mt-1 text-sm text-tekst-daempet">
        Beskyt din konto, og se hvor du er logget ind.
      </p>

      <div className="mt-5 border-t border-kant pt-5">
        <h3 className={H3}>Adgangskode</h3>
        <div className="mt-3">
          <SkiftAdgangskode person={{ email: bruger.email, navn: [profil?.navn] }} />
        </div>
      </div>

      <div className="mt-5 border-t border-kant pt-5">
        <h3 className={H3}>Enheder der har været logget ind</h3>
        <p className="mt-1 text-sm text-tekst-daempet">
          Logger nogen ind fra en ny enhed, får du en mail.
        </p>
        <div className="mt-3">
          {enhedFejl ? (
            <p role="alert" className="text-sm text-fejl-tekst">
              Listen kunne ikke hentes lige nu. Prøv igen om lidt.
            </p>
          ) : (
            <Enheder enheder={enheder} />
          )}
        </div>
      </div>
    </section>
  );
}

export function DineDataSektion({ dataStatus }: { dataStatus?: string }) {
  return (
    <section id="dine-data" className={`mt-6 scroll-mt-24 ${KORT}`}>
      <h2 className={H2}>Dine data</h2>

      <div className="mt-3">
        <h3 className={H3}>Download dine data</h3>
        <p className="mt-1 text-sm text-tekst-daempet">
          Få en fil med alt det, BidHamr har gemt om dig: profil, auktioner, bud, handler, beskeder, bedømmelser og
          indstillinger. Filen er i JSON-format og kan åbnes i en teksteditor.
        </p>
        {dataStatus === "vent" && (
          <p role="alert" className={`mt-3 ${FORMULAR_FEJL}`}>
            Du har lige hentet dine data. Du kan hente dem igen om højst en time.
          </p>
        )}
        {dataStatus === "fejl" && (
          <p role="alert" className={`mt-3 ${FORMULAR_FEJL}`}>
            Dine data kunne ikke hentes lige nu. Prøv igen om lidt.
          </p>
        )}
        <form action="/konto/data" method="POST" className="mt-3">
          <button type="submit" className="btn btn-sekundaer w-full sm:w-auto">
            Download dine data
          </button>
        </form>
        <p className="mt-1.5 text-[13px] text-tekst-daempet">Du kan hente filen én gang i timen.</p>
      </div>

      <div className="mt-5 border-t border-kant pt-5">
        <h3 className={H3}>Slet konto</h3>
        <p className="mt-1 text-sm text-tekst-daempet">
          Sletter dine personlige oplysninger og lukker kontoen for altid. Oplysninger om dine handler gemmes, fordi
          loven kræver det.
        </p>
        <Link href="/konto/slet" className="btn btn-fare mt-3 w-full sm:w-auto">
          Slet min konto
        </Link>
      </div>

      <div className="mt-5 border-t border-kant pt-5">
        <h3 className={H3}>Betingelser og privatliv</h3>
        <ul className="mt-2 flex flex-col gap-1 text-sm sm:flex-row sm:gap-6">
          <li>
            <Link href={PRIVATLIV_STI} className={`${LINK} inline-flex min-h-11 items-center sm:min-h-0`}>
              Sådan behandler vi dine oplysninger
            </Link>
          </li>
          <li>
            <Link href={BETINGELSER_STI} className={`${LINK} inline-flex min-h-11 items-center sm:min-h-0`}>
              Brugerbetingelser
            </Link>
          </li>
        </ul>
      </div>

      <p className="mt-5 text-[13px] text-tekst-daempet">
        Spørgsmål om dine data? Skriv til{" "}
        <a href="mailto:support@bidhamr.dk" className={LINK}>
          support@bidhamr.dk
        </a>
        .
      </p>
    </section>
  );
}
