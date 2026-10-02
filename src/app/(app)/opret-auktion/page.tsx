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
    .select("stripe_account_id, connect_detaljer_indsendt, connect_overfoersler_aktiv")
    .eq("user_id", data.user.id)
    .maybeSingle<{
      stripe_account_id: string | null;
      connect_detaljer_indsendt: boolean;
      connect_overfoersler_aktiv: boolean;
    }>();

  const harKonto = !!profil?.stripe_account_id;
  const kanSaelge = harKonto && !!profil?.connect_detaljer_indsendt;
  const aktiv = kanSaelge && !!profil?.connect_overfoersler_aktiv;

  return (
    <main className="flex flex-1 justify-center bg-white px-4 py-10">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Opret auktion
        </h1>

        <div className="mt-6">
          {kanSaelge && stripe !== "retur" ? (
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
