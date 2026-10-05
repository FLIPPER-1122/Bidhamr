import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import HandelStatusBadge, { AKTIVE_STATUSSER } from "@/components/HandelStatusBadge";
import { hentMineAktiveTilbud } from "@/app/actions/andenchanceBruger";
import Nedtaelling from "@/components/betaling/Nedtaelling";
import { sagLink, type SagStatus } from "@/lib/sager";

export const dynamic = "force-dynamic";

type HandelRaekke = {
  id: string;
  status: string;
  amount: number | string;
  created_at: string;
  buyer_id: string;
  seller_id: string;
  auctions: { titel: string; billeder: string[] | null } | null;
  // Sager på handlen (hentes med i samme forespørgsel; RLS: kun parterne).
  sager: { id: string; status: SagStatus; oprettet_kl: string }[] | null;
};

const SAG_AKTIV: SagStatus[] = ["aaben", "afventer_retur"];

// Mærke på handelskortet, når der er en sag.
const SAG_MAERKE: Record<SagStatus, { tekst: string; stil: string }> = {
  aaben: { tekst: "Sag i gang", stil: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst" },
  afventer_retur: { tekst: "Afventer retur", stil: "border-info-kant bg-info-bg text-info-tekst" },
  afgjort_koeber: { tekst: "Sag afgjort", stil: "border-kant-staerk bg-neutral-50 text-tekst-daempet" },
  afgjort_saelger: { tekst: "Sag afgjort", stil: "border-kant-staerk bg-neutral-50 text-tekst-daempet" },
  lukket: { tekst: "Sag lukket", stil: "border-kant-staerk bg-neutral-50 text-tekst-daempet" },
};

// Den nyeste sag på handlen (der er normalt kun én).
function nyesteSag(h: HandelRaekke) {
  const sager = h.sager ?? [];
  if (sager.length === 0) return null;
  return sager.reduce((a, b) => (Date.parse(b.oprettet_kl) > Date.parse(a.oprettet_kl) ? b : a));
}

function HandelKort({
  handel,
  brugerId,
}: {
  handel: HandelRaekke;
  brugerId: string;
}) {
  const erKoeber = handel.buyer_id === brugerId;
  const billede = handel.auctions?.billeder?.[0] ?? null;
  const sag = nyesteSag(handel);
  const sagAktiv = !!sag && SAG_AKTIV.includes(sag.status);

  return (
    <Link
      href={sagAktiv ? sagLink(handel.id) : `/mine-handler/${handel.id}`}
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
        {sag && (
          <span
            className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${SAG_MAERKE[sag.status].stil}`}
          >
            {SAG_MAERKE[sag.status].tekst}
          </span>
        )}
        {/* Hele kortet er linket til handelssiden; dette er en synlig
            markering af, at chatten ligger derinde. Et <Link> her ville
            være et link inde i et link. */}
        <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-groen">
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5a8.5 8.5 0 0 1 17 0z"
            />
          </svg>
          Start chat
        </span>
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

  // or-filteret er det, der begrænser til egne handler. RLS alene ville ikke
  // gøre det: policyen tillader også staff at se alt.
  const [{ data }, tilbud] = await Promise.all([
    supabase
    .from("trades")
    .select("id, status, amount, created_at, buyer_id, seller_id, auctions(titel, billeder), sager(id, status, oprettet_kl)")
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .order("created_at", { ascending: false })
    .overrideTypes<HandelRaekke[], { merge: false }>(),
    hentMineAktiveTilbud(),
  ]);

  const handler = data ?? [];
  const aktive = handler.filter((h) => AKTIVE_STATUSSER.includes(h.status));
  const afsluttede = handler.filter((h) => !AKTIVE_STATUSSER.includes(h.status));
  const medSag = handler.filter((h) => {
    const s = nyesteSag(h);
    return !!s && SAG_AKTIV.includes(s.status);
  });

  return (
    <main className="flex-1 bg-white px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-neutral-900">Mine handler</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Handler hvor du er køber eller sælger.
        </p>

        {medSag.length > 0 && (
          <section
            aria-labelledby="sager-titel"
            className="mt-6 rounded-[14px] border border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst sm:p-5"
          >
            <h2 id="sager-titel" className="font-semibold">
              {medSag.length === 1 ? "Du har 1 sag i gang" : `Du har ${medSag.length} sager i gang`}
            </h2>
            <ul className="mt-2 space-y-1">
              {medSag.map((h) => (
                <li key={h.id}>
                  <Link
                    href={sagLink(h.id)}
                    className="inline-flex min-h-11 max-w-full items-center gap-1 text-sm font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                  >
                    <span className="truncate">Se sagen om {h.auctions?.titel ?? "din handel"}</span>
                    <span aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {tilbud.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm font-semibold text-neutral-900">Tilbud til dig</h2>
            <div className="mt-3 space-y-2">
              {tilbud.map((t) => (
                <Link
                  key={t.id}
                  href={`/andenchance/${t.id}`}
                  className="flex flex-col gap-2 rounded-xl border border-[#F5D9B0] bg-[#FEF3E2] p-4 text-[#8A4210] transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{t.titel}</span>
                    <span className="block text-sm">
                      Du kan købe varen for dit bud · <Nedtaelling til={t.udloeber} />
                    </span>
                  </span>
                  <span className="btn btn-primaer btn-lille shrink-0">Se tilbud</span>
                </Link>
              ))}
            </div>
          </section>
        )}

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
