import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import OpretAuktionForm from "@/components/OpretAuktionForm";
import UdbetalingskontoKraeves from "@/components/betaling/UdbetalingskontoKraeves";

// Man skal have en udbetalingskonto for at sælge (ROADMAP-BESLUTNINGER,
// "Udbetalingskonto og advarsler fra admin"). Kravet er, at kontoen er
// oprettet og oplysningerne sendt ind hos Stripe – Stripe må gerne stadig
// behandle den. Databasen håndhæver det samme (auctions_kraev_udbetalingskonto).
export default async function OpretAuktionPage({
  searchParams,
}: {
  searchParams: Promise<{ stripe?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  const { stripe } = await searchParams;

  // RLS: brugeren kan kun læse sin egen betalingsprofil.
  const { data: profil } = await supabase
    .from("betalingsprofiler")
    // "*": connect_frakoblet_kl findes først efter 20261003060000_connect_status.sql.
    .select("*")
    .eq("user_id", data.user.id)
    .maybeSingle<{
      stripe_account_id: string | null;
      connect_detaljer_indsendt: boolean;
      connect_overfoersler_aktiv: boolean;
      connect_frakoblet_kl?: string | null;
    }>();

  const harKonto = !!profil?.stripe_account_id;
  // En lukket/frakoblet udbetalingskonto kan ikke bruges (samme regel som
  // har_udbetalingskonto i databasen).
  const frakoblet = !!profil?.connect_frakoblet_kl;
  const kanSaelge = harKonto && !!profil?.connect_detaljer_indsendt && !frakoblet;
  const aktiv = kanSaelge && !!profil?.connect_overfoersler_aktiv;

  return (
    <main className="flex flex-1 justify-center bg-white px-4 py-10">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Opret auktion
        </h1>

        <div className="mt-6">
          {frakoblet ? (
            <p className="rounded-lg border border-[#F3C4C4] bg-[#FDECEC] px-4 py-3 text-sm text-[#A32020]">
              Din udbetalingskonto hos vores betalingspartner Stripe er lukket, så du kan ikke sætte
              varer til salg lige nu. Skriv til support@bidhamr.dk, så hjælper vi dig.
            </p>
          ) : kanSaelge && stripe !== "retur" ? (
            <>
              {!aktiv && (
                <p className="mb-6 rounded-lg border border-[#C9DCEB] bg-[#EDF3F8] px-4 py-3 text-sm text-[#1F4E79]">
                  Stripe behandler din udbetalingskonto. Du kan godt sætte varer til salg imens.
                </p>
              )}
              <OpretAuktionForm brugerId={data.user.id} />
            </>
          ) : (
            <UdbetalingskontoKraeves
              harKonto={harKonto}
              erRetur={stripe === "retur"}
              erFejl={stripe === "fejl"}
            />
          )}
        </div>
      </div>
    </main>
  );
}
