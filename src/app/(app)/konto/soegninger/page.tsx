import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentGemteSoegninger } from "@/app/actions/gemteSoegninger";
import KontoSideHoved from "@/components/konto/KontoSideHoved";
import GemteSoegninger from "@/components/soegning/GemteSoegninger";
import { MAKS_GEMTE_SOEGNINGER } from "@/lib/gemteSoegninger";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Gemte søgninger", robots: { index: false, follow: false } };

export default async function GemteSoegningerSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/konto/soegninger");

  const svar = await hentGemteSoegninger();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <KontoSideHoved
        titel="Gemte søgninger"
        krumme="Gemte søgninger"
        tekst={`Få besked, når der kommer nye auktioner, der matcher. Du kan gemme op til ${MAKS_GEMTE_SOEGNINGER} søgninger.`}
      />
      {"fejl" in svar ? (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {svar.fejl}
        </p>
      ) : (
        <GemteSoegninger start={svar.soegninger} />
      )}
    </main>
  );
}
