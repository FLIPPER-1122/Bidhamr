import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import HandelStatusBadge, { HANDEL_STATUS } from "@/components/HandelStatusBadge";
import HandelChat, { type Besked } from "@/components/HandelChat";
import { SendPakkeForm, BekraeftModtagelseKnap } from "@/components/HandelHandlinger";

export const dynamic = "force-dynamic";

type HandelRaekke = {
  id: string;
  auction_id: string;
  seller_id: string;
  buyer_id: string;
  amount: number | string;
  status: string;
  tracking_number: string | null;
  created_at: string;
};

export default async function HandelDetaljePage({
  params,
}: {
  params: Promise<{ trade_id: string }>;
}) {
  const { trade_id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?redirect=/mine-handler/${trade_id}`);
  }

  // RLS returnerer intet til uvedkommende, så dette dækker også adgangskontrol.
  const { data: handel } = await supabase
    .from("trades")
    .select("id, auction_id, seller_id, buyer_id, amount, status, tracking_number, created_at")
    .eq("id", trade_id)
    .maybeSingle<HandelRaekke>();

  if (!handel) notFound();

  const modpartId =
    handel.buyer_id === user.id ? handel.seller_id : handel.buyer_id;

  const [{ data: auktion }, { data: modpart }, { data: beskeder }] =
    await Promise.all([
      supabase.from("auctions").select("titel, billeder").eq("id", handel.auction_id).maybeSingle(),
      supabase.from("users").select("navn, email").eq("id", modpartId).maybeSingle(),
      supabase
        .from("messages")
        .select("id, sender_id, content, created_at")
        .eq("trade_id", trade_id)
        .order("created_at", { ascending: true })
        .overrideTypes<Besked[], { merge: false }>(),
    ]);

  const erSaelger = handel.seller_id === user.id;
  const erKoeber = handel.buyer_id === user.id;
  const aktivtTrin = HANDEL_STATUS.findIndex((s) => s.vaerdi === handel.status);
  const billede = (auktion?.billeder as string[] | null)?.[0] ?? null;

  return (
    <main className="flex-1 bg-white px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href="/mine-handler"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Tilbage til mine handler
        </Link>

        {/* Overblik */}
        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100">
              {billede ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={billede} alt="" className="h-full w-full object-cover" />
              ) : (
                <svg className="h-6 w-6 text-neutral-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.5h16.5a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5H3.75a1.5 1.5 0 01-1.5-1.5V6a1.5 1.5 0 011.5-1.5z" />
                </svg>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-bold text-neutral-900">
                {auktion?.titel ?? "Slettet auktion"}
              </h1>
              <p className="mt-0.5 text-sm text-neutral-500">
                {erKoeber ? "Du er køber" : "Du er sælger"} ·{" "}
                {Number(handel.amount).toLocaleString("da-DK")} kr
              </p>
            </div>
            <HandelStatusBadge status={handel.status} />
          </div>

          {/* Statustidslinje */}
          <ol className="mt-6 flex flex-wrap gap-2">
            {HANDEL_STATUS.map((trin, i) => {
              const naaet = i <= aktivtTrin;
              return (
                <li
                  key={trin.vaerdi}
                  className={`flex-1 rounded-lg border px-3 py-2 text-center text-xs font-medium ${
                    naaet
                      ? "border-brand bg-[#FDECEE] text-brand"
                      : "border-neutral-200 text-neutral-400"
                  }`}
                >
                  {trin.label}
                </li>
              );
            })}
          </ol>

          {handel.tracking_number && (
            <p className="mt-4 rounded-lg bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
              Sporingsnummer:{" "}
              <span className="font-semibold">{handel.tracking_number}</span>
            </p>
          )}
        </div>

        {/* Handlinger */}
        {erSaelger && handel.status === "betaling_modtaget" && (
          <div className="rounded-xl border border-neutral-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-neutral-900">Send pakken</h2>
            <p className="mt-1 mb-4 text-sm text-neutral-500">
              Indtast sporingsnummeret, når du har sendt varen. Køberen får besked.
            </p>
            <SendPakkeForm tradeId={handel.id} />
          </div>
        )}

        {erKoeber && handel.status === "pakke_sendt" && (
          <div className="rounded-xl border border-neutral-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-neutral-900">
              Har du modtaget varen?
            </h2>
            <p className="mt-1 mb-4 text-sm text-neutral-500">
              Når du bekræfter, frigives beløbet til sælgeren.
            </p>
            <BekraeftModtagelseKnap tradeId={handel.id} />
          </div>
        )}

        {(handel.status === "leveret" || handel.status === "afsluttet") && (
          <div className="rounded-xl border border-green-300 bg-green-50 p-6">
            <p className="font-semibold text-green-700">Handlen er gennemført</p>
            <p className="mt-1 text-sm text-green-700">
              Varen er bekræftet modtaget.
            </p>
          </div>
        )}

        <HandelChat
          tradeId={handel.id}
          brugerId={user.id}
          modpartNavn={modpart?.navn ?? "modparten"}
          startBeskeder={beskeder ?? []}
        />
      </div>
    </main>
  );
}
