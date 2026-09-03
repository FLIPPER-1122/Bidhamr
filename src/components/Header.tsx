import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import LogoutButton from "@/components/LogoutButton";
import { kategorier } from "@/lib/kategorier";
import { kr } from "@/lib/wallet";

export default async function Header() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  let erAdmin = false;
  let saldo: number | null = null;
  if (data.user) {
    // RLS lader kun brugeren se sin egen konto, saa der er ingen filtrering
    // at glemme her.
    const [{ data: profil }, { data: wallet }] = await Promise.all([
      supabase.from("users").select("rolle").eq("id", data.user.id).single(),
      supabase
        .from("wallets")
        .select("balance")
        .eq("user_id", data.user.id)
        .maybeSingle(),
    ]);
    saldo = wallet ? Number(wallet.balance) : null;
    erAdmin =
      profil?.rolle === "chef" ||
      profil?.rolle === "admin" ||
      profil?.rolle === "medarbejder";
  }

  return (
    <header className="bg-white shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
      <div className="flex min-h-[78px] items-center gap-8 px-8 py-4">
        <Link href="/" className="text-3xl font-extrabold tracking-tight text-brand">
          BidHamr
        </Link>

        <nav className="hidden items-center gap-6 sm:flex">
          <Link
            href="/auktioner"
            className="text-sm text-[#6B7280] hover:text-brand"
          >
            Alle auktioner
          </Link>

        </nav>

        <form action="/auktioner" method="GET" className="relative flex-1 px-2">
          <button
            type="submit"
            aria-label="Søg"
            className="absolute top-1/2 left-5 -translate-y-1/2 text-brand"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4.5 w-4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="M21 21l-4.3-4.3" />
            </svg>
          </button>
          <input
            type="search"
            name="q"
            placeholder="Søg efter varer…"
            className="w-full rounded-full border border-brand bg-white py-2.5 pl-11 pr-5 text-sm text-neutral-900 outline-none placeholder:text-[#6B7280] focus:ring-2 focus:ring-brand"
          />
        </form>

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
              {erAdmin && (
                <Link
                  href="/admin"
                  className="hidden items-center gap-1.5 text-sm font-medium text-brand hover:underline sm:flex"
                >
                  <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  Admin
                </Link>
              )}
              {saldo !== null && (
                <Link
                  href="/konto"
                  title="Din saldo — klik for at indbetale"
                  className="flex items-center gap-1.5 rounded-full border border-brand bg-red-50 px-3 py-1.5 text-sm font-semibold text-brand hover:bg-brand hover:text-white"
                >
                  <span aria-hidden="true">💰</span>
                  {kr(saldo)}
                </Link>
              )}
              <Link
                href="/konto"
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
                    d="M3 10h18M3 10a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2M3 10v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8M16 15h2"
                  />
                </svg>
                Min konto
              </Link>
              <Link
                href="/mine-handler"
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
                    d="M16 11V7a4 4 0 0 0-8 0v4M5 9h14l1 12H4L5 9z"
                  />
                </svg>
                Mine handler
              </Link>
              <Link
                href="/profil/mig"
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
