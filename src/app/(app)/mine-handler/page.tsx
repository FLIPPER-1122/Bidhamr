import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import HandelStatusBadge, { AKTIVE_STATUSSER } from "@/components/HandelStatusBadge";

export const dynamic = "force-dynamic";

type HandelRaekke = {
  id: string;
  status: string;
  amount: number | string;
  created_at: string;
  buyer_id: string;
  seller_id: string;
  auctions: { titel: string; billeder: string[] | null } | null;
};

function HandelKort({
  handel,
  brugerId,
}: {
  handel: HandelRaekke;
  brugerId: string;
}) {
  const erKoeber = handel.buyer_id === brugerId;
  const billede = handel.auctions?.billeder?.[0] ?? null;

  return (
    <Link
      href={`/mine-handler/${handel.id}`}
      className="flex items-center gap-4 rounded-xl border border-neutral-200 bg-white p-4 transition-shadow hover:shadow-md"
    >
      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100">
        {billede ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={billede}
            alt={handel.auctions?.titel ?? ""}
            className="h-full w-full object-cover"
          />
        ) : (
          <svg className="h-6 w-6 text-neutral-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 4.5h16.5a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5H3.75a1.5 1.5 0 01-1.5-1.5V6a1.5 1.5 0 011.5-1.5z" />
          </svg>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-neutral-900">
          {handel.auctions?.titel ?? "Slettet auktion"}
        </p>
        <p className="mt-0.5 text-sm text-neutral-500">
          {erKoeber ? "Du er køber" : "Du er sælger"} ·{" "}
          {new Date(handel.created_at).toLocaleDateString("da-DK")}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="font-bold text-neutral-900">
          {Number(handel.amount).toLocaleString("da-DK")} kr
        </span>
        <HandelStatusBadge status={handel.status} />
      </div>
    </Link>
  );
}

export default async function MineHandlerPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?redirect=/mine-handler");
  }

  // RLS begrænser allerede til egne handler; or-filteret gør det eksplicit.
  const { data } = await supabase
    .from("trades")
    .select("id, status, amount, created_at, buyer_id, seller_id, auctions(titel, billeder)")
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .order("created_at", { ascending: false })
    .overrideTypes<HandelRaekke[], { merge: false }>();

  const handler = data ?? [];
  const aktive = handler.filter((h) => AKTIVE_STATUSSER.includes(h.status));
  const afsluttede = handler.filter((h) => !AKTIVE_STATUSSER.includes(h.status));

  return (
    <main className="flex-1 bg-white px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-neutral-900">Mine handler</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Handler hvor du er køber eller sælger.
        </p>

        {handler.length === 0 ? (
          <div className="mt-8 rounded-xl border border-neutral-200 bg-white p-10 text-center text-neutral-400">
            Du har ingen handler endnu.
          </div>
        ) : (
          <>
            <section className="mt-8">
              <h2 className="text-sm font-semibold text-neutral-900">
                Aktive handler ({aktive.length})
              </h2>
              <div className="mt-3 space-y-2">
                {aktive.map((h) => (
                  <HandelKort key={h.id} handel={h} brugerId={user.id} />
                ))}
                {aktive.length === 0 && (
                  <p className="rounded-xl border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-400">
                    Ingen aktive handler
                  </p>
                )}
              </div>
            </section>

            {afsluttede.length > 0 && (
              <section className="mt-8">
                <h2 className="text-sm font-semibold text-neutral-900">
                  Afsluttede handler ({afsluttede.length})
                </h2>
                <div className="mt-3 space-y-2">
                  {afsluttede.map((h) => (
                    <HandelKort key={h.id} handel={h} brugerId={user.id} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
