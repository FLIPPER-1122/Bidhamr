import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import LogoutButton from "@/components/LogoutButton";

export default async function Header() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  return (
    <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 sm:px-8">
      <Link href="/" className="text-xl font-bold text-brand">
        Hamr
      </Link>

      <nav className="flex items-center gap-3 sm:gap-4">
        <Link
          href="/opret-auktion"
          className="text-sm font-medium text-neutral-700 hover:text-brand"
        >
          Opret auktion
        </Link>

        {data.user ? (
          <>
            <Link
              href="/profil"
              className="text-sm font-medium text-neutral-700 hover:text-brand"
            >
              Min profil
            </Link>
            <LogoutButton />
          </>
        ) : (
          <>
            <Link
              href="/login"
              className="text-sm font-medium text-neutral-700 hover:text-brand"
            >
              Log ind
            </Link>
            <Link
              href="/signup"
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
            >
              Opret konto
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
