import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import KontoSideHoved from "@/components/konto/KontoSideHoved";
import AdresseFormular from "@/components/konto/AdresseFormular";
import { LINK } from "@/components/konto/felter";
import { hentFakturaNavn, hentMinAdresse } from "@/lib/adresse/server";
import { ADRESSE_TEKST as T } from "@/lib/adresse/regler";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Min adresse", robots: { index: false, follow: false } };

// Min konto -> Min adresse: adressen til kvitteringer og fakturaer
// (bruger_adresser, 20261102340000). Kun brugeren selv kan læse den (RLS).
// Navnet på fakturaer er låst til navnet fra MitID, når brugeren er
// verificeret; ellers profilens navn (rettes under Profil).
export default async function AdresseSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  const bruger = authData.user;
  if (!bruger) redirect("/login?redirect=/konto/adresse");

  const [adresse, navn] = await Promise.all([hentMinAdresse(supabase, bruger.id), hentFakturaNavn(supabase, bruger.id)]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <KontoSideHoved titel={T.sideTitel} krumme={T.sideTitel} tekst={T.sideTekst} />

      <section aria-labelledby="faktura-navn" className="mt-6 rounded-none border border-kant bg-white p-5 sm:p-6">
        <h2 id="faktura-navn" className="text-[20px] leading-tight lg:text-[22px]">
          {T.navnTitel}
        </h2>
        {navn.navn && <p className="mt-2 text-[15px] font-medium text-tekst">{navn.navn}</p>}
        <p className="mt-1 text-sm text-tekst-daempet">
          {navn.mitid ? (
            T.navnMitId
          ) : (
            <>
              {T.navnUdenMitId}{" "}
              <Link href={`/profil/${bruger.id}?fane=indstillinger`} className={LINK}>
                Ret dit navn
              </Link>
            </>
          )}
        </p>
      </section>

      <section aria-labelledby="min-adresse" className="mt-6 rounded-none border border-kant bg-white p-5 sm:p-6">
        <h2 id="min-adresse" className="text-[20px] leading-tight lg:text-[22px]">
          {T.sideTitel}
        </h2>
        {adresse === "fejl" ? (
          <p role="alert" className="mt-3 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
            Din adresse kunne ikke hentes lige nu. Prøv igen om lidt.
          </p>
        ) : (
          <div className="mt-4 max-w-md">
            <AdresseFormular start={adresse} />
          </div>
        )}
        <p className="mt-4 text-[13px] text-tekst-daempet">{T.afhentning}</p>
      </section>
    </main>
  );
}
