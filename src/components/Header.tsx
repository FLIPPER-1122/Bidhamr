import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import LogoutButton from "@/components/LogoutButton";

const kategorier = [
  "Møbler",
  "Elektronik",
  "Tøj",
  "Køretøjer",
  "Sport",
  "Værktøj",
  "Alt andet",
];

export default async function Header() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  return (
    <header className="border-b border-neutral-200">
      {/* Mini-bar */}
      <div className="hidden items-center justify-between bg-neutral-100 px-4 py-1.5 text-xs text-neutral-600 sm:flex sm:px-8">
        <div className="flex items-center gap-5">
          <span className="flex items-center gap-1">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" />
            </svg>
            Find auktion nær dig
          </span>
          <span>+45 70 12 34 56</span>
          <span>support@hamr.dk</span>
        </div>

        <div className="flex items-center gap-5">
          <a href="#" className="hover:text-brand">
            Køb
          </a>
          <a href="#" className="hover:text-brand">
            Sælg
          </a>
          <a href="#" className="hover:text-brand">
            Levering
          </a>
          <a href="#" className="hover:text-brand">
            Hjælp
          </a>
        </div>
      </div>

      {/* Hoved-navigation */}
      <div className="flex items-center gap-6 px-4 py-3 sm:px-8">
        <Link href="/" className="text-2xl font-bold text-brand">
          hamr
        </Link>

        <nav className="hidden items-center gap-5 sm:flex">
          <Link
            href="/"
            className="text-sm font-medium text-neutral-700 hover:text-brand"
          >
            Auktioner
          </Link>

          <div className="group relative">
            <button className="flex items-center gap-1 text-sm font-medium text-neutral-700 hover:text-brand">
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
                  className="block px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 hover:text-brand"
                >
                  {kategori}
                </a>
              ))}
            </div>
          </div>
        </nav>

        <div className="flex-1">
          <input
            type="search"
            placeholder="Søg efter varer…"
            className="w-full rounded-full border border-neutral-300 px-4 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
        </div>

        <div className="flex items-center gap-4">
          <a
            href="#"
            className="hidden items-center gap-1.5 text-sm font-medium text-neutral-700 hover:text-brand sm:flex"
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
                className="flex items-center gap-1.5 text-sm font-medium text-neutral-700 hover:text-brand"
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
              className="flex items-center gap-1.5 text-sm font-medium text-neutral-700 hover:text-brand"
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
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-[#d62b38]"
          >
            Opret auktion
          </Link>
        </div>
      </div>
    </header>
  );
}
