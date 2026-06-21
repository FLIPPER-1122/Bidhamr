import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import LogoutButton from "@/components/LogoutButton";
import { kategorier } from "@/lib/kategorier";

export default async function Header() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  return (
    <header className="bg-white shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
      <div className="flex min-h-[78px] items-center gap-8 px-8 py-4">
        <Link href="/" className="text-3xl font-extrabold tracking-tight text-brand">
          hamr
        </Link>

        <nav className="hidden items-center gap-6 sm:flex">
          <Link
            href="/"
            className="text-sm text-[#6B7280] hover:text-brand"
          >
            Auktioner
          </Link>

          <div className="group relative">
            <button className="flex items-center gap-1 text-sm text-[#6B7280] hover:text-brand">
              Kategorier
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                <path d="M7 10l5 5 5-5z" />
              </svg>
            </button>

            <div className="invisible absolute left-0 z-10 mt-2 w-44 rounded-lg border border-neutral-200 bg-white py-2 opacity-0 shadow-lg group-hover:visible group-hover:opacity-100">
              {kategorier.map((kategori) => (
                <a
                  key={kategori}
                  href="#"
                  className="block px-4 py-2 text-sm text-[#6B7280] hover:bg-neutral-50 hover:text-brand"
                >
                  {kategori}
                </a>
              ))}
            </div>
          </div>
        </nav>

        <div className="relative flex-1 px-2">
          <svg
            viewBox="0 0 24 24"
            className="pointer-events-none absolute top-1/2 left-5 h-4.5 w-4.5 -translate-y-1/2 text-brand"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <circle cx="11" cy="11" r="7" />
            <path strokeLinecap="round" d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="search"
            placeholder="Søg efter varer…"
            className="w-full rounded-full border border-brand bg-white py-2.5 pl-11 pr-5 text-sm text-neutral-900 outline-none placeholder:text-[#6B7280] focus:ring-2 focus:ring-brand"
          />
        </div>

        <div className="flex items-center gap-6">
          <a
            href="#"
            className="hidden items-center gap-1.5 text-sm text-[#6B7280] hover:text-brand sm:flex"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 21s-7.5-4.5-9.5-9C1 8.5 2.5 5 6 5c2 0 3.5 1 4 2 0.5-1 2-2 4-2 3.5 0 5 3.5 3.5 7-2 4.5-9.5 9-9.5 9z"
              />
            </svg>
            Favoritter
          </a>

          {data.user ? (
            <>
              <Link
                href="/profil"
                className="flex items-center gap-1.5 text-sm text-[#6B7280] hover:text-brand"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"
                  />
                </svg>
                Min profil
              </Link>
              <LogoutButton />
            </>
          ) : (
            <Link
              href="/login"
              className="flex items-center gap-1.5 text-sm text-[#6B7280] hover:text-brand"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"
                />
              </svg>
              Log ind
            </Link>
          )}

          <Link
            href="/opret-auktion"
            className="bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38]"
          >
            Opret auktion
          </Link>
        </div>
      </div>
    </header>
  );
}
