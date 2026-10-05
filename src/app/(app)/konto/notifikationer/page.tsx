import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentIndstillinger } from "@/app/actions/notifikationer";
import NotifikationIndstillinger from "@/components/notifikationer/NotifikationIndstillinger";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Notifikationsindstillinger" };

export default async function NotifikationIndstillingerSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/konto/notifikationer");

  const svar = await hentIndstillinger();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <nav aria-label="Brødkrumme" className="flex items-center text-sm">
        <Link
          href="/konto"
          className="inline-flex min-h-11 items-center rounded-md font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          Min konto
        </Link>
        <span aria-hidden="true" className="mx-2 text-tekst-svag">/</span>
        <span className="text-tekst-daempet" aria-current="page">Notifikationer</span>
      </nav>

      <h1 className="mt-1 text-[26px] leading-tight break-words hyphens-auto sm:text-[32px]">
        Notifikationsindstillinger
      </h1>
      <p className="mt-2 max-w-[65ch] text-[15px] text-tekst-daempet">
        Vælg, hvordan du vil have besked: i klokken her på siden, på mail eller som push i appen.
      </p>

      {"fejl" in svar ? (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Dine indstillinger kunne ikke hentes. {svar.fejl}
        </p>
      ) : (
        <NotifikationIndstillinger start={svar.indstillinger} />
      )}
    </main>
  );
}
