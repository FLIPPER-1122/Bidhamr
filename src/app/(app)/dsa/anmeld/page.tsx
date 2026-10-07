import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import AnmeldFormular from "@/components/dsa/AnmeldFormular";

// Anmeld ulovligt indhold med et link (footeren: "Anmeld ulovligt indhold").
// Virker uden login.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Anmeld ulovligt indhold",
  description: "Anmeld en auktion, en profil eller andet indhold på BidHamr, som du mener er ulovligt.",
};

export default async function AnmeldSide() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">
      <h1 className="font-serif text-[26px] leading-tight font-semibold text-tekst sm:text-[32px]">
        Anmeld ulovligt indhold
      </h1>
      <p className="mt-2 text-base text-tekst-daempet">
        Mener du, at noget på BidHamr er ulovligt eller bryder vores regler? Indsæt et link, og fortæl os hvorfor. Du
        kan også trykke på <strong className="font-semibold text-tekst">Anmeld</strong> direkte ved en auktion,
        profil, et spørgsmål eller en bedømmelse.
      </p>

      <div className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
        <AnmeldFormular loggetInd={!!user} />
      </div>

      <p className="mt-6 text-sm text-tekst-svag">
        Vil du høre, hvordan vi behandler anmeldelser og klager?{" "}
        <Link href="/dsa" className="font-medium text-groen hover:underline">
          Læs mere om ulovligt indhold og dine rettigheder
        </Link>
        . Har du brug for hjælp til en handel, så{" "}
        <Link href="/kontakt" className="font-medium text-groen hover:underline">
          kontakt kundeservice
        </Link>
        .
      </p>
    </main>
  );
}
