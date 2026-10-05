import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SletKontoForm from "@/components/konto/SletKontoForm";
import Blokeringer from "@/components/konto/Blokeringer";
import type { Blokering } from "@/app/actions/kontoSletning";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Slet konto", robots: { index: false, follow: false } };

export default async function SletKontoSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/konto/slet");

  const { data, error } = await supabase.rpc("min_konto_sletning_status");
  if (error) console.error("Slet konto: status kunne ikke hentes:", error.message);
  const status = data as
    | { kode: string; kan_slettes: boolean; blokeringer: Blokering[]; aktive_auktioner_uden_bud: number | null }
    | null;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <Link href="/konto#dine-data" className="inline-flex min-h-11 items-center text-sm font-medium text-groen hover:underline">
        ← Tilbage til Min konto
      </Link>
      <h1 className="mt-2 text-[26px] leading-tight sm:text-[32px]">Slet konto</h1>

      <section className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
        <h2 className="text-[20px] leading-tight lg:text-[22px]">Det sker, når du sletter din konto</h2>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[15px] text-tekst">
          <li>Dit navn, din e-mail, dit telefonnummer, din adresse og dit profilbillede fjernes.</li>
          <li>Dine gemte kort, favoritter, følgere og notifikationer slettes.</li>
          <li>Auktioner uden bud, der stadig er i gang, bliver afsluttet.</li>
          <li>Du bliver logget ud alle steder og kan ikke logge ind igen.</li>
        </ul>
        <h3 className="mt-5 text-[17px] leading-snug lg:text-[18px]">Det gemmer vi</h3>
        <p className="mt-1 text-[15px] text-tekst-daempet">
          Oplysninger om dine handler, betalinger, gebyrer og sager gemmer vi, fordi bogføringsloven kræver det. Dine
          beskeder i handler og dine bedømmelser bliver også, men står under navnet &quot;Slettet bruger&quot;.
        </p>
        <p className="mt-3 text-[15px] text-tekst-daempet">
          Vil du have en kopi af dine data først?{" "}
          <Link href="/konto#dine-data" className="font-medium text-groen hover:underline">
            Download dine data
          </Link>
          . Du kan altid oprette en ny konto med samme e-mail senere.
        </p>
      </section>

      {!status || status.kode !== "ok" ? (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Vi kunne ikke tjekke din konto lige nu. Prøv igen om lidt.
        </p>
      ) : status.kan_slettes ? (
        <section className="mt-6 rounded-[14px] border border-fejl-kant bg-white p-5 sm:p-6">
          <h2 className="text-[20px] leading-tight lg:text-[22px]">Bekræft sletning</h2>
          {(status.aktive_auktioner_uden_bud ?? 0) > 0 && (
            <p className="mt-2 rounded-xl border border-advarsel-kant bg-advarsel-bg p-4 text-sm text-advarsel-tekst">
              Du har {status.aktive_auktioner_uden_bud === 1 ? "1 auktion" : `${status.aktive_auktioner_uden_bud} auktioner`} i
              gang uden bud. {status.aktive_auktioner_uden_bud === 1 ? "Den" : "De"} bliver afsluttet, når du sletter din konto.
            </p>
          )}
          <div className="mt-4">
            <SletKontoForm />
          </div>
        </section>
      ) : (
        <section className="mt-6 rounded-[14px] border border-advarsel-kant bg-advarsel-bg p-5 sm:p-6">
          <h2 className="text-[20px] leading-tight text-advarsel-tekst lg:text-[22px]">
            Din konto kan ikke slettes endnu
          </h2>
          <p className="mt-1 text-sm text-advarsel-tekst">
            Der er ting i gang, som skal gøres færdige først, så ingen køber eller sælger står tilbage uden svar. Når
            listen er tom, kan du slette din konto.
          </p>
          <div className="mt-4">
            <Blokeringer blokeringer={status.blokeringer} />
          </div>
        </section>
      )}
    </main>
  );
}
