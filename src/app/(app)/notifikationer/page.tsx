import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentNotifikationer } from "@/app/actions/notifikationer";
import Indbakke from "@/components/notifikationer/Indbakke";
import { SIDE_STOERRELSE } from "@/lib/notifikationer/visning";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Notifikationer" };

export default async function NotifikationerSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/notifikationer");

  // Én ekstra, så vi ved, om "Vis flere" skal vises.
  const svar = await hentNotifikationer({ antal: SIDE_STOERRELSE + 1 });

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="font-serif text-[26px] font-semibold leading-tight text-tekst sm:text-[32px]">
          Notifikationer
        </h1>
        <Link
          href="/konto/notifikationer"
          className="text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          Indstillinger
        </Link>
      </div>

      {"fejl" in svar ? (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Dine notifikationer kunne ikke hentes. {svar.fejl}
        </p>
      ) : (
        <Indbakke
          start={svar.notifikationer.slice(0, SIDE_STOERRELSE)}
          flereStart={svar.notifikationer.length > SIDE_STOERRELSE}
        />
      )}
    </main>
  );
}
