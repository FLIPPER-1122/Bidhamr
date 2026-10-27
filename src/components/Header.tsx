import Link from "next/link";
import HenvisningLink from "@/components/henvisning/HenvisningLink";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { bekraeftetBruger, hentBruger, hentKontoFelter, hentMinRolle, sessionBrugerId } from "@/lib/supabase/bruger";
import KontoMenu from "@/components/KontoMenu";
import Klokke from "@/components/notifikationer/Klokke";
import Ikon from "@/components/Ikon";
import BeskederLink from "@/components/topbar/BeskederLink";
import KategoriMenu from "@/components/topbar/KategoriMenu";
import MobilMenu from "@/components/topbar/MobilMenu";
import { UlaesteBeskederProvider } from "@/components/topbar/UlaesteBeskeder";
import { KATEGORIER_I_LINJEN, UDFORSK, kategoriHref } from "@/components/topbar/navigation";
import { ERHVERV_MENU } from "@/lib/tekster/erhverv";
import { foerLancering } from "@/lib/lancering";
import { MINE_HANDLER_HREF } from "@/lib/profilFaner";

const ikonKnap =
  "flex h-11 w-11 items-center justify-center rounded-full text-tekst-daempet hover:bg-groen-lys hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";
const linjeLink =
  "flex min-h-11 items-center rounded-lg font-medium text-[#444] hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";
// I rullefeltet: fokusringen lægges indenfor, så den ikke klippes.
const linjeLinkRul =
  "flex min-h-11 items-center rounded-lg px-1 font-medium whitespace-nowrap text-[#444] hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen";

// Topbar efter DESIGN.md afsnit 9 og mockup D.
// Mobil (< lg): logo, klokke og burger; søgefeltet i fuld bredde nedenunder.
// Desktop (lg+): logo, søgefelt i midten, genveje, "Sælg en vare" og
// profil-menu – med en kategorilinje under.
export default async function Header() {
  // Er der en gyldig session (lokal JWT-tjek, intet netværkskald), startes
  // tællerne og rollen SAMTIDIG med getUser i stedet for bagefter. RPC'erne
  // udleder selv brugeren af auth.uid() i JWT'en, og tallene bruges kun, hvis
  // getUser godkender den samme bruger. Bruger og rolle deles med siden og
  // adminAuth (cache() i src/lib/supabase/bruger.ts).
  const sessionId = await sessionBrugerId();
  const supabase = sessionId ? await createClient() : null;
  const [bruger, rolle, antal, antalBeskeder, kontoFelter] = await Promise.all([
    sessionId ? bekraeftetBruger(sessionId) : hentBruger(),
    sessionId ? hentMinRolle() : null,
    supabase ? supabase.rpc("notifikationer_antal_ulaeste").then((r) => r.data) : null,
    supabase ? supabase.rpc("antal_ulaeste_staff_beskeder").then((r) => r.data) : null,
    // Delt med siden (cache() i src/lib/supabase/bruger.ts).
    sessionId ? hentKontoFelter(sessionId) : null,
  ]);
  const loggetInd = !!bruger;

  // Firmakonto: profilmenuen viser kun "Firma oversigt" og "Log ud".
  const erFirma = !!bruger && kontoFelter?.konto_type === "erhverv";
  // Privat bruger uden MitID: lille markering på profilmenuen og et punkt
  // "Bekræft med MitID" (kræves før første bud/auktion - firmaer er undtaget).
  // Kun visning; databasen håndhæver kravet (BHV01).
  const mitidMangler = !!bruger && !!kontoFelter && !erFirma && !kontoFelter.mitid_verificeret_kl;
  // Før lancering kan en firmakonto kun nå Firma oversigt (gaten i
  // src/lib/supabase/middleware.ts). Så vises kun logo, profilmenu og log ud -
  // ingen søgning, kategorier, klokke eller beskeder, der alligevel bare
  // sender tilbage til /firma (og klokken/beskeder spørger serveren via server
  // actions, som firmaet ikke må kalde før lancering).
  const kunFirma = erFirma && foerLancering();
  // Erhvervssælgeren (rollen 'saelger') må før lancering kun bruge Admin →
  // Erhverv: gaten afviser server actions på alle andre stier (403). Klokken
  // og tælleren for beskeder spørger serveren via server actions, så de vises
  // / kører ikke for sælgeren før lancering (ellers konsolfejl på fx /login,
  // /glemt-adgangskode og /erhverv).
  const saelgerFoerLancering = rolle === "saelger" && foerLancering();
  // "Sælgere du følger" i kategorilinjen (kun indloggede private). På
  // 1024-1279 px gives der plads ved at vise kategorierne fra xl.
  const visFoelger = loggetInd && !erFirma;
  // Også efter lancering har firmaet alt sit eget i firma-dashboardet
  // (/firma/*, eget layout uden denne header). På de offentlige sider vises
  // derfor ikke favoritter, beskeder, mine handler, klokke eller "Sælg en
  // vare" for en firmakonto - kun profilmenuen med "Firma oversigt".
  let erAdmin = false;
  let ulaeste = 0;
  let ulaesteBeskeder = 0;
  if (bruger) {
    ulaesteBeskeder = Number(antalBeskeder ?? 0) || 0;
    erAdmin = rolle === "chef" || rolle === "admin" || rolle === "medarbejder" || rolle === "saelger";
    ulaeste = Number(antal ?? 0) || 0;
  }

  return (
    <UlaesteBeskederProvider startAntal={ulaesteBeskeder} aktiv={loggetInd && !erFirma && !saelgerFoerLancering}>
      <a
        href="#indhold"
        className="sr-only z-[60] rounded-lg bg-white px-4 py-3 font-medium text-groen shadow-flyder focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:outline-2 focus:outline-groen"
      >
        Spring til indhold
      </a>

      {/* relative: klokke-panelet lægger sig i fuld bredde under headeren på mobil. */}
      <header className="relative border-b border-kant bg-white">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-2 gap-y-3 px-4 py-3 sm:px-6 lg:flex-nowrap lg:gap-x-6 lg:px-8 lg:py-4">
          <Link
            href="/"
            aria-label="BidHamr - til forsiden"
            className="mr-auto flex min-h-11 shrink-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:mr-0"
          >
            <Image
              src="/brand/bidhamr-logo.svg"
              alt="BidHamr"
              width={230}
              height={60}
              preload
              unoptimized
              className="h-8 w-auto lg:h-9"
            />
          </Link>

          {!kunFirma && (
          <form
            action="/auktioner"
            method="GET"
            role="search"
            className="relative order-last w-full lg:order-none lg:w-auto lg:min-w-0 lg:flex-1"
          >
            <label htmlFor="header-soeg" className="sr-only">
              Søg efter varer
            </label>
            <input
              id="header-soeg"
              type="search"
              name="q"
              placeholder="Søg efter alt fra ure til sofaer…"
              className="h-11 w-full rounded-none border-[1.5px] border-kant-staerk bg-white py-2.5 pr-14 pl-5 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
            />
            {/* Touch-målet er 44x44; den synlige orange firkant er 34px (kantet som feltet). */}
            <button
              type="submit"
              aria-label="Søg"
              className="group absolute top-1/2 right-0 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              <span className="flex h-[34px] w-[34px] items-center justify-center rounded-none bg-orange-knap text-white group-hover:bg-orange-knap-mork">
                <Ikon navn="soeg" className="h-[18px] w-[18px]" strøg={2} />
              </span>
            </button>
          </form>
          )}

          <div className="flex shrink-0 items-center gap-1 lg:gap-2">
            {/* Favoritter: hjertet er den eneste vej til favoritterne (også på
                mobil - punktet er ikke længere i menuerne). */}
            {!erFirma && (
              <Link href="/favoritter" aria-label="Favoritter" title="Favoritter" className={ikonKnap}>
                <Ikon navn="hjerte" />
              </Link>
            )}
            {/* Kun store skærme: genveje som ikoner */}
            {loggetInd && !erFirma && (
              <>
                <BeskederLink className={`${ikonKnap} hidden lg:flex`} />
                <Link
                  href={MINE_HANDLER_HREF}
                  className="hidden h-11 items-center gap-2 rounded-none px-3 text-sm font-medium text-tekst-daempet hover:bg-groen-lys hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:flex"
                >
                  <Ikon navn="handler" />
                  <span className="sr-only xl:not-sr-only">Mine handler</span>
                </Link>
              </>
            )}

            {loggetInd && !erFirma && !saelgerFoerLancering && <Klokke startAntal={ulaeste} />}

            {!loggetInd && (
              <HenvisningLink
                href="/login"
                className="hidden h-11 items-center px-2 text-sm font-medium text-[#333] hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:flex"
              >
                Log ind
              </HenvisningLink>
            )}

            {/* .btn sætter display: wrapperen styrer, hvornår knappen vises. */}
            {!erFirma && (
              <div className="hidden shrink-0 lg:block">
                <Link href="/opret-auktion" className="btn btn-primaer">
                  Sælg en vare
                </Link>
              </div>
            )}

            {loggetInd && (
              <div className="hidden lg:block">
                <KontoMenu erAdmin={erAdmin} erFirma={erFirma} mitidMangler={mitidMangler} />
              </div>
            )}

            <div className="lg:hidden">
              <MobilMenu loggetInd={loggetInd} erAdmin={erAdmin} erFirma={erFirma} kunFirma={kunFirma} mitidMangler={mitidMangler} />
            </div>
          </div>
        </div>

        {/* Kategorilinje – kun store skærme; på mobil ligger den i menuen. */}
        {!kunFirma && (
        <nav aria-label="Kategorier og genveje" className="hidden border-t border-kant lg:block">
          <div className="mx-auto flex max-w-[1280px] items-center gap-5 px-8 text-sm">
            {/* Uden for rullefeltet, så dropdown'en ikke bliver klippet. */}
            <div className="shrink-0">
              <KategoriMenu />
            </div>
            {/* Ruller vandret, hvis der ikke er plads (fx 1024 px med
                "Sælgere du følger"), så linjen aldrig brydes. */}
            <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto [scrollbar-width:none]">
              {UDFORSK.slice(1).map((l) => (
                <Link key={l.href} href={l.href} className={`${linjeLinkRul} shrink-0`}>
                  {l.tekst}
                </Link>
              ))}
              {KATEGORIER_I_LINJEN.map((k, i) => (
                <Link key={k} href={kategoriHref(k)} className={`${linjeLinkRul} shrink-0 ${i > 1 || visFoelger ? "hidden xl:flex" : ""}`}>
                  {k}
                </Link>
              ))}
              {/* Kun for indloggede (ikke firmakonti) - lige efter "Sport". */}
              {visFoelger && (
                <Link href="/konto/foelger" className={`${linjeLinkRul} shrink-0 gap-1.5`}>
                  <Ikon navn="foelgere" className="h-[18px] w-[18px]" />
                  Sælgere du følger
                </Link>
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-5">
              <Link href="/bidhamr-beskyttelse" className="flex min-h-11 items-center gap-1.5 rounded-lg font-medium text-groen-mork hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
                <Ikon navn="skjold" className="h-[18px] w-[18px]" />
                BidHamr Beskyttelse
              </Link>
              <Link href="/saadan-virker-det" className={linjeLink}>
                Sådan virker det
              </Link>
              {/* En firmakonto er allerede kunde - salgsknappen skjules. */}
              {!erFirma && (
                <Link href="/erhverv" className={`${linjeLink} font-semibold text-groen-mork`}>
                  {ERHVERV_MENU.topmenu}
                </Link>
              )}
            </div>
          </div>
        </nav>
        )}
      </header>
    </UlaesteBeskederProvider>
  );
}
