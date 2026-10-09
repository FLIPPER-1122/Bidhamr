import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentMineFakturaer } from "@/lib/faktura/data";
import { FAKTURA_TEKST as T } from "@/lib/faktura/tekster";
import KontoSideHoved from "@/components/konto/KontoSideHoved";
import TomTilstand from "@/components/TomTilstand";
import FakturaListe from "@/components/faktura/FakturaListe";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Fakturaer", robots: { index: false, follow: false } };

// Brugerens fakturaer og kreditnotaer fra BidHamr (mine_fakturaer udleder
// brugeren af auth.uid() - man ser kun egne). PDF via /api/faktura/<id>.
export default async function FakturaerSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/konto/fakturaer");

  const fakturaer = await hentMineFakturaer(supabase);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <KontoSideHoved titel={T.sideTitel} krumme={T.sideTitel} tekst={T.sideIntro} />
      {fakturaer === null ? (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {T.fejl}
        </p>
      ) : fakturaer.length === 0 ? (
        <TomTilstand className="mt-6" ikon="handler" titel={T.tomTitel} tekst={T.tomTekst} />
      ) : (
        <div className="mt-6">
          <FakturaListe fakturaer={fakturaer} />
        </div>
      )}
    </main>
  );
}
