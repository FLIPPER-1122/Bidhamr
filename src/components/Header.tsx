import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import KontoMenu from "@/components/KontoMenu";

export default async function Header() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  let erAdmin = false;
  if (data.user) {
    const { data: rolle } = await supabase.rpc("min_rolle");
    erAdmin =
      rolle === "chef" ||
      rolle === "admin" ||
      rolle === "medarbejder";
  }

  return (
    <header className="border-b border-kant bg-white">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-3 gap-y-3 px-4 py-3 sm:px-6 lg:flex-nowrap lg:gap-x-6 lg:px-8 lg:py-4">
        <Link
          href="/"
          aria-label="BidHamr - til forsiden"
          className="shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          <Image
            src="/brand/bidhamr-logo.svg"
            alt="BidHamr"
            width={230}
            height={60}
            priority
            unoptimized
            className="h-8 w-auto lg:h-9"
          />
        </Link>

        <Link
          href="/auktioner"
          className="hidden shrink-0 text-sm font-medium text-tekst-daempet hover:text-groen xl:block"
        >
          Alle auktioner
        </Link>

        {/* Mobil: søgefeltet i fuld bredde under logo-linjen */}
        <form
          action="/auktioner"
          method="GET"
          role="search"
          className="relative order-last w-full lg:order-none lg:w-auto lg:min-w-0 lg:flex-1"
        >
          <label htmlFor="header-soeg" className="sr-only">
            Søg efter varer
          </label>
          <button
            type="submit"
            aria-label="Søg"
            className="group absolute top-1/2 right-0 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-orange-knap text-white group-hover:bg-orange-knap-mork"><svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="M21 21l-4.3-4.3" />
            </svg></span>
          </button>
          <input
            id="header-soeg"
            type="search"
            name="q"
            placeholder="Søg efter varer…"
            className="h-11 w-full rounded-full border-[1.5px] border-kant-staerk bg-white py-2.5 pl-5 pr-14 text-[15px] text-tekst outline-none placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25"
          />
        </form>

        <div className="ml-auto flex shrink-0 items-center gap-2 lg:ml-0">
          <Link href="/favoritter" aria-label="Favoritter" title="Favoritter" className="hidden h-11 w-11 items-center justify-center rounded-full text-tekst-daempet hover:bg-groen-lys hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:flex">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 21s-7.5-4.5-9.5-9C1 8.5 2.5 5 6 5c2 0 3.5 1 4 2 0.5-1 2-2 4-2 3.5 0 5 3.5 3.5 7-2 4.5-9.5 9-9.5 9z" />
            </svg>
          </Link>
          {data.user ? (
            <Link href="/mine-handler" aria-label="Mine handler" title="Mine handler" className="hidden h-11 w-11 items-center justify-center rounded-full text-tekst-daempet hover:bg-groen-lys hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:flex">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16 11V7a4 4 0 0 0-8 0v4M5 9h14l1 12H4L5 9z" />
            </svg>
            </Link>
          ) : (
            <Link
              href="/login"
              className="hidden h-11 items-center px-2 text-sm font-medium text-tekst-daempet hover:text-groen lg:flex"
            >
              Log ind
            </Link>
          )}

          {/* .btn er ulagdelt CSS og ville overtrumfe "hidden" – derfor en wrapper */}
          <div className="hidden shrink-0 lg:block">
            <Link href="/opret-auktion" className="btn btn-primaer">
              Opret auktion
            </Link>
          </div>

          <div className={data.user ? "" : "lg:hidden"}>
            <KontoMenu
              logget_ind={!!data.user}
              erAdmin={erAdmin}
            />
          </div>
        </div>
      </div>
    </header>
  );
}
