import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import KontoSideHoved from "@/components/konto/KontoSideHoved";
import BoostKoeb from "@/components/boost/BoostKoeb";
import { synkBoostRetur } from "@/lib/betaling/boost";
import { BOOST_TEKST } from "@/lib/boost/tekster";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Boost-point", robots: { index: false, follow: false } };

type MinePoint = {
  saldo: number;
  kan_bruge: boolean;
  spaerret: string | null;
  pakke: { point: number; pris_oere: number };
  boost: { point: number; timer: number };
  point_pr_salg: number;
  kraev_samtykke: boolean;
  aabent_koeb: { id: string; status: string } | null;
  historik: {
    id: string;
    type: string;
    point: number;
    oensket_point: number | null;
    saldo_efter: number;
    kl: string;
    auktion_id: string | null;
    auktion_titel: string | null;
  }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Kun et link tilbage til en auktion (aldrig en vilkårlig adresse).
function sikkerRetur(fra: string | undefined): string | null {
  const m = /^\/auktion\/([0-9a-f-]{36})$/i.exec(fra ?? "");
  return m && UUID.test(m[1]) ? `/auktion/${m[1]}` : null;
}

function dato(iso: string) {
  return new Date(iso).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

// Min konto -> Boost-point: saldo, historik og "Køb 100 point – 39 kr."
// (mine_point udleder brugeren af auth.uid() - man ser kun sit eget).
export default async function BoostSide({
  searchParams,
}: {
  searchParams: Promise<{ boost?: string; payment_intent?: string; fra?: string }>;
}) {
  const { boost, payment_intent, fra } = await searchParams;
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/konto/boost");
  const retur = sikkerRetur(fra);

  // Retur fra betalingen: slå PaymentIntenten op hos Stripe med det samme
  // (kun brugerens eget køb), så pointene ikke venter på webhooken.
  let returKode: string | null = null;
  if (boost === "retur" && typeof payment_intent === "string") {
    returKode = await synkBoostRetur(authData.user.id, payment_intent);
  }

  const { data, error } = await supabase.rpc("mine_point");
  const p = (error ? null : data) as MinePoint | null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <KontoSideHoved titel={BOOST_TEKST.sideTitel} krumme={BOOST_TEKST.sideTitel} tekst={BOOST_TEKST.sideIntro} />

      {!p ? (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {BOOST_TEKST.fejl.fejl}
        </p>
      ) : (
        <>
          {boost === "retur" && (
            <p
              role="status"
              className={`mt-6 rounded-xl border p-4 text-sm ${
                returKode === "betalt" || returKode === "allerede"
                  ? "border-succes-kant bg-succes-bg text-succes-tekst"
                  : "border-kant bg-groen-lys text-tekst"
              }`}
            >
              {returKode === "betalt" || returKode === "allerede"
                ? BOOST_TEKST.koebGennemfoert(p.pakke.point)
                : BOOST_TEKST.betalingBehandles}
              {retur && (
                <>
                  {" "}
                  <Link href={retur} className="font-medium text-groen underline">
                    Tilbage til din auktion
                  </Link>
                </>
              )}
            </p>
          )}

          <section aria-labelledby="saldo-titel" className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 id="saldo-titel" className="text-[15px] font-medium text-tekst-daempet">
              {BOOST_TEKST.saldoLabel}
            </h2>
            <p className="mt-1 text-[32px] leading-tight font-bold text-tekst">{BOOST_TEKST.saldo(p.saldo)}</p>
            <ul className="mt-4 space-y-1.5 text-sm text-tekst-daempet">
              {BOOST_TEKST.saadan(p.pakke.point, p.pakke.pris_oere, p.boost.point, p.boost.timer, p.point_pr_salg).map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <div id="koeb" className="scroll-mt-24">
              {p.kan_bruge ? (
                <BoostKoeb
                  point={p.pakke.point}
                  prisOere={p.pakke.pris_oere}
                  kraevSamtykke={p.kraev_samtykke}
                  retur={retur}
                />
              ) : (
                <p className="mt-4 text-sm text-tekst">
                  {p.spaerret === "erhverv" ? BOOST_TEKST.kunPrivate : BOOST_TEKST.spaerret}
                </p>
              )}
            </div>
          </section>

          <section aria-labelledby="historik-titel" className="mt-6">
            <h2 id="historik-titel" className="text-[20px] leading-tight lg:text-[22px]">
              {BOOST_TEKST.historikTitel}
            </h2>
            {p.historik.length === 0 ? (
              <p className="mt-2 text-sm text-tekst-daempet">{BOOST_TEKST.historikTom}</p>
            ) : (
              <ul className="mt-3 divide-y divide-kant rounded-[14px] border border-kant bg-white">
                {p.historik.map((h) => (
                  <li key={h.id} className="flex items-start justify-between gap-4 p-4">
                    <div className="min-w-0">
                      <p className="text-[15px] font-medium text-tekst">
                        {BOOST_TEKST.type[h.type] ?? h.type}
                        {h.type === "forbrug" && h.auktion_id && (
                          <>
                            {": "}
                            <Link href={`/auktion/${h.auktion_id}`} className="font-normal text-groen underline">
                              {h.auktion_titel ?? "din auktion"}
                            </Link>
                          </>
                        )}
                      </p>
                      <p className="mt-0.5 text-[13px] text-tekst-svag">
                        {dato(h.kl)}
                        {h.type === "tilbagefoersel" && h.oensket_point !== null && -h.point < h.oensket_point
                          ? ` · ${-h.point} af ${h.oensket_point} point (du havde ikke flere)`
                          : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={`text-[15px] font-semibold tabular-nums ${h.point > 0 ? "text-succes-tekst" : "text-tekst"}`}>
                        {h.point > 0 ? "+" : h.point < 0 ? "−" : ""}
                        {Math.abs(h.point)}
                      </p>
                      <p className="text-[13px] text-tekst-svag tabular-nums">Saldo {h.saldo_efter}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
