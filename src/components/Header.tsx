import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { bekraeftetBruger, hentBruger, hentMinRolle, sessionBrugerId } from "@/lib/supabase/bruger";
import KontoMenu from "@/components/KontoMenu";
import Klokke from "@/components/notifikationer/Klokke";
import Ikon from "@/components/Ikon";
import BeskederLink from "@/components/topbar/BeskederLink";
import KategoriMenu from "@/components/topbar/KategoriMenu";
import MobilMenu from "@/components/topbar/MobilMenu";
import { UlaesteBeskederProvider } from "@/components/topbar/UlaesteBeskeder";
import { KATEGORIER_I_LINJEN, UDFORSK, kategoriHref } from "@/components/topbar/navigation";
import { ERHVERV_MENU } from "@/lib/tekster/erhverv";

const ikonKnap =
  "flex h-11 w-11 items-center justify-center rounded-full text-tekst-daempet hover:bg-groen-lys hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";
const linjeLink =
  "flex min-h-11 items-center rounded-lg font-medium text-[#444] hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";

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
  const [bruger, rolle, antal, antalBeskeder, kontoType] = await Promise.all([
    sessionId ? bekraeftetBruger(sessionId) : hentBruger(),
    sessionId ? hentMinRolle() : null,
    supabase ? supabase.rpc("notifikationer_antal_ulaeste").then((r) => r.data) : null,
    supabase ? supabase.rpc("antal_ulaeste_staff_beskeder").then((r) => r.data) : null,
    // users.konto_type kan læses af alle (20261010030000_erhverv.sql).
    supabase && sessionId
      ? supabase
          .from("users")
          .select("konto_type")
          .eq("id", sessionId)
          .maybeSingle<{ konto_type: string | null }>()
          .then((r) => r.data?.konto_type ?? null)
      : null,
  ]);
  const loggetInd = !!bruger;

  // Firmakonto: profilmenuen viser kun "Firma oversigt" og "Log ud".
  const erFirma = !!bruger && kontoType === "erhverv";
  let erAdmin = false;
  let ulaeste = 0;
  let ulaesteBeskeder = 0;
  if (bruger) {
    ulaesteBeskeder = Number(antalBeskeder ?? 0) || 0;
    erAdmin = rolle === "chef" || rolle === "admin" || rolle === "medarbejder" || rolle === "saelger";
    ulaeste = Number(antal ?? 0) || 0;
  }

  return (
    <UlaesteBeskederProvider startAntal={ulaesteBeskeder} aktiv={loggetInd}>
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
              className="h-11 w-full rounded-full border-[1.5px] border-kant-staerk bg-white py-2.5 pr-14 pl-5 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
            />
            {/* Touch-målet er 44x44; den synlige orange cirkel er 34px. */}
            <button
              type="submit"
              aria-label="Søg"
              className="group absolute top-1/2 right-0 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-orange-knap text-white group-hover:bg-orange-knap-mork">
                <Ikon navn="soeg" className="h-[18px] w-[18px]" strøg={2} />
              </span>
            </button>
          </form>

          <div className="flex shrink-0 items-center gap-1 lg:gap-2">
            {/* Kun store skærme: genveje som ikoner */}
            <Link href="/favoritter" aria-label="Favoritter" title="Favoritter" className={`${ikonKnap} hidden lg:flex`}>
              <Ikon navn="hjerte" />
            </Link>
            {loggetInd && (
              <>
                <BeskederLink className={`${ikonKnap} hidden lg:flex`} />
                <Link
                  href="/mine-handler"
                  className="hidden h-11 items-center gap-2 rounded-full px-3 text-sm font-medium text-tekst-daempet hover:bg-groen-lys hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:flex"
                >
                  <Ikon navn="handler" />
                  <span className="sr-only xl:not-sr-only">Mine handler</span>
                </Link>
              </>
            )}

            {loggetInd && <Klokke startAntal={ulaeste} />}

            {!loggetInd && (
              <Link
                href="/login"
                className="hidden h-11 items-center px-2 text-sm font-medium text-[#333] hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:flex"
              >
                Log ind
              </Link>
            )}

            {/* .btn sætter display: wrapperen styrer, hvornår knappen vises. */}
            <div className="hidden shrink-0 lg:block">
              <Link href="/opret-auktion" className="btn btn-primaer">
                Sælg en vare
              </Link>
            </div>

            {loggetInd && (
              <div className="hidden lg:block">
                <KontoMenu erAdmin={erAdmin} erFirma={erFirma} />
              </div>
            )}

            <div className="lg:hidden">
              <MobilMenu loggetInd={loggetInd} erAdmin={erAdmin} erFirma={erFirma} />
            </div>
          </div>
        </div>

        {/* Kategorilinje – kun store skærme; på mobil ligger den i menuen. */}
        <nav aria-label="Kategorier og genveje" className="hidden border-t border-kant lg:block">
          <div className="mx-auto flex max-w-[1280px] items-center gap-7 px-8 text-sm">
            <KategoriMenu />
            {UDFORSK.slice(1).map((l) => (
              <Link key={l.href} href={l.href} className={linjeLink}>
                {l.tekst}
              </Link>
            ))}
            {KATEGORIER_I_LINJEN.map((k, i) => (
              <Link key={k} href={kategoriHref(k)} className={`${linjeLink} ${i > 1 ? "hidden xl:flex" : ""}`}>
                {k}
              </Link>
            ))}
            <div className="ml-auto flex items-center gap-7">
              <Link href="/bidhamr-beskyttelse" className="flex min-h-11 items-center gap-1.5 rounded-lg font-medium text-groen-mork hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
                <Ikon navn="skjold" className="h-[18px] w-[18px]" />
                BidHamr Beskyttelse
              </Link>
              <Link href="/saadan-virker-det" className={linjeLink}>
                Sådan virker det
              </Link>
              <Link href="/erhverv" className={`${linjeLink} font-semibold text-groen-mork`}>
                {ERHVERV_MENU.topmenu}
              </Link>
            </div>
          </div>
        </nav>
      </header>
    </UlaesteBeskederProvider>
  );
}
