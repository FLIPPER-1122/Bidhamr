import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentBetalingsindstillinger } from "@/app/actions/betaling";
import KontoBetaling from "@/components/betaling/KontoBetaling";
import KontoUdbetaling from "@/components/betaling/KontoUdbetaling";

export const dynamic = "force-dynamic";

export default async function KontoSide({
  searchParams,
}: {
  searchParams: Promise<{ stripe?: string; setup_intent?: string }>;
}) {
  const { stripe, setup_intent } = await searchParams;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    redirect("/login?redirect=/konto");
  }

  const indstillinger = await hentBetalingsindstillinger();

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="font-serif text-3xl font-semibold text-tekst">Min konto</h1>

      {"fejl" in indstillinger ? (
        <p
          role="alert"
          className="mt-6 rounded-xl border border-[#F3C4C4] bg-[#FDECEC] p-4 text-sm text-[#A32020]"
        >
          Dine betalingsindstillinger kunne ikke hentes. {indstillinger.fejl}
        </p>
      ) : (
        <>
          <section className="mt-6 rounded-2xl border border-kant bg-white p-5 sm:p-6">
            <h2 className="font-serif text-xl font-semibold text-tekst">Betaling</h2>
            <div className="mt-3">
              <KontoBetaling
                gemtKort={indstillinger.gemtKort}
                autobetaling={indstillinger.autobetaling}
                setupIntentId={
                  setup_intent?.startsWith("seti_") ? setup_intent : null
                }
              />
            </div>
          </section>

          <section className="mt-6 rounded-2xl border border-kant bg-white p-5 sm:p-6">
            <h2 className="font-serif text-xl font-semibold text-tekst">Udbetaling</h2>
            <div className="mt-3">
              <KontoUdbetaling
                saelger={indstillinger.saelger}
                erRetur={stripe === "retur"}
              />
            </div>
          </section>
        </>
      )}

      <section className="mt-6 rounded-2xl border border-kant bg-white p-5 sm:p-6">
        <h2 className="font-serif text-xl font-semibold text-tekst">Notifikationer</h2>
        <p className="mt-1 text-sm text-tekst-daempet">
          Vælg, hvilke beskeder du vil have i klokken, på mail og i appen.
        </p>
        <Link href="/konto/notifikationer" className="btn btn-sekundaer mt-4">
          Notifikationsindstillinger
        </Link>
      </section>

      <p className="mt-6 text-sm text-tekst-daempet">
        Se dine køb og salg under{" "}
        <Link href="/mine-handler" className="font-medium text-groen hover:underline">
          Mine handler
        </Link>
        .
      </p>
    </main>
  );
}
