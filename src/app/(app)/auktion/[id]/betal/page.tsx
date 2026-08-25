import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import BetalKnap from "@/components/BetalKnap";

export default async function BetalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    redirect(`/login?redirect=/auktion/${id}/betal`);
  }

  const { data: auktion } = await supabase
    .from("auctions")
    .select("*")
    .eq("id", id)
    .single();

  if (!auktion) {
    redirect("/");
  }

  const { data: højesteBud } = await supabase
    .from("bids")
    .select("*")
    .eq("auktion_id", id)
    .order("beløb", { ascending: false })
    .limit(1)
    .maybeSingle();

  const erVinder = højesteBud?.bruger_id === authData.user.id;
  const auktionErSlut = new Date(auktion.slutter_kl) <= new Date();

  const { data: betaltTransaktion } = await supabase
    .from("transactions")
    .select("*")
    .eq("auktion_id", id)
    .eq("status", "betalt")
    .maybeSingle();

  return (
    <main className="flex flex-1 justify-center bg-white px-4 py-10">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold text-neutral-900">Betaling</h1>

        {!auktionErSlut ? (
          <p className="mt-4 text-sm text-neutral-600">
            Denne auktion er ikke slut endnu.
          </p>
        ) : !højesteBud ? (
          <p className="mt-4 text-sm text-neutral-600">
            Denne auktion fik ingen bud.
          </p>
        ) : !erVinder ? (
          <p className="mt-4 text-sm text-neutral-600">
            Du har ikke vundet denne auktion.
          </p>
        ) : (
          <>
            <div className="mt-6 flex gap-4 border border-neutral-200 p-4">
              {auktion.billeder?.[0] && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={auktion.billeder[0]}
                  alt={auktion.titel}
                  className="h-20 w-20 object-cover"
                />
              )}
              <div className="flex-1">
                <p className="font-medium text-neutral-900">{auktion.titel}</p>
                <p className="mt-1 text-sm text-neutral-500">
                  Vindende bud
                </p>
                <p className="text-lg font-bold text-neutral-900">
                  {Number(højesteBud.beløb).toLocaleString("da-DK")} kr
                </p>
              </div>
            </div>

            {(() => {
              // Samme øre-beregning som checkout-routen, så totalen matcher Stripe.
              const budØre = Math.round(Number(højesteBud.beløb) * 100);
              const gebyrØre = Math.round(budØre * 0.05);
              const kr = (øre: number) =>
                (øre / 100).toLocaleString("da-DK", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                });
              return (
                <div className="mt-4 border border-neutral-200 p-4 text-sm">
                  <div className="flex justify-between text-neutral-600">
                    <span>Vindende bud</span>
                    <span>{kr(budØre)} kr</span>
                  </div>
                  <div className="mt-2 flex justify-between text-neutral-600">
                    <span>Hamr gebyr (5%)</span>
                    <span>{kr(gebyrØre)} kr</span>
                  </div>
                  <div className="mt-3 flex justify-between border-t border-neutral-200 pt-3 font-bold text-neutral-900">
                    <span>I alt</span>
                    <span>{kr(budØre + gebyrØre)} kr</span>
                  </div>
                </div>
              );
            })()}

            <p className="mt-3 text-xs text-neutral-500">
              Beløbet opbevares sikkert af BidHamr (escrow), indtil du har
              modtaget og godkendt varen.
            </p>

            <div className="mt-6">
              {betaltTransaktion ? (
                <p className="border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-700">
                  Betalingen er allerede gennemført. Tak!
                </p>
              ) : (
                <BetalKnap auktionId={auktion.id} />
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
