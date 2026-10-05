import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentMineStaffSamtaler } from "@/app/actions/staffChat";
import { fjernFaellesPraefiks } from "@/lib/staffChat";
import {
  AfsluttetMaerke,
  BidhamrMaerke,
  beskedTid,
  forkort,
} from "@/components/staffchat/visning";

export const dynamic = "force-dynamic";

// Antal handelschats, der vises. Resten ligger under Mine handler.
const ANTAL_HANDLER = 20;

type HandelRaekke = {
  id: string;
  buyer_id: string;
  seller_id: string;
  created_at: string;
  auctions: { titel: string | null } | null;
};

type SidsteBesked = {
  trade_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  fra_bidhamr: boolean;
};

export default async function BeskederPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirect=/beskeder");

  // or-filteret begrænser til egne handler (RLS tillader også staff alt).
  const [staff, { data: handlerData, error: handelFejl }] = await Promise.all([
    hentMineStaffSamtaler(),
    supabase
      .from("trades")
      .select("id, buyer_id, seller_id, created_at, auctions(titel)")
      .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
      .order("created_at", { ascending: false })
      .limit(ANTAL_HANDLER)
      .overrideTypes<HandelRaekke[], { merge: false }>(),
  ]);

  const handler = handlerData ?? [];
  // Seneste besked pr. handel (højst ANTAL_HANDLER små opslag, parallelt).
  const seneste = await Promise.all(
    handler.map((h) =>
      supabase
        .from("messages")
        .select("trade_id, sender_id, content, created_at, fra_bidhamr")
        .eq("trade_id", h.id)
        // Beskeder, spamfilteret har stoppet, vises ikke som seneste besked.
        .is("blokeret_grund", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<SidsteBesked>(),
    ),
  );
  const sidste = new Map<string, SidsteBesked>();
  for (const { data: b } of seneste) if (b) sidste.set(b.trade_id, b);

  // Handler med beskeder først (nyeste besked øverst), derefter resten.
  const sorteret = [...handler].sort((a, b) => {
    const ta = Date.parse(sidste.get(a.id)?.created_at ?? "") || 0;
    const tb = Date.parse(sidste.get(b.id)?.created_at ?? "") || 0;
    return tb - ta || Date.parse(b.created_at) - Date.parse(a.created_at);
  });

  return (
    <main className="flex-1 bg-white px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="font-serif text-[26px] leading-tight font-semibold text-tekst sm:text-[32px]">
          Beskeder
        </h1>

        <section aria-labelledby="fra-bidhamr" className="mt-8">
          <h2 id="fra-bidhamr" className="font-serif text-xl font-semibold text-tekst">
            Fra BidHamr
          </h2>
          {"fejl" in staff ? (
            <p role="alert" className="mt-3 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
              Beskederne fra BidHamr kunne ikke hentes. Prøv igen om lidt.
            </p>
          ) : staff.samtaler.length === 0 ? (
            <p className="mt-3 rounded-[14px] border border-kant p-5 text-sm text-tekst-daempet">
              Du har ingen beskeder fra BidHamr.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {staff.samtaler.map((s) => {
                const ulaest = s.antal_ulaeste > 0;
                return (
                  <li key={s.id}>
                    <Link
                      href={`/beskeder/bidhamr/${s.id}`}
                      className={`flex gap-3 rounded-[14px] border p-4 transition-colors hover:border-kant-staerk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                        ulaest ? "border-succes-kant bg-groen-lys" : "border-kant bg-white"
                      }`}
                    >
                      <span className="flex w-2.5 shrink-0 justify-center pt-2" aria-hidden="true">
                        {ulaest && <span className="h-2.5 w-2.5 rounded-full bg-orange-knap" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <BidhamrMaerke lille />
                          {s.lukket_kl && <AfsluttetMaerke />}
                          {ulaest && (
                            <span className="text-[12px] font-semibold text-groen-mork">
                              {s.antal_ulaeste === 1 ? "1 ny besked" : `${s.antal_ulaeste} nye beskeder`}
                            </span>
                          )}
                        </span>
                        <span className={`mt-1.5 block break-words text-[15px] text-tekst ${ulaest ? "font-semibold" : "font-medium"}`}>
                          {s.emne}
                        </span>
                        {s.auktion_titel && (
                          <span className="block truncate text-[13px] text-tekst-svag">
                            Handel: {s.auktion_titel}
                          </span>
                        )}
                        {s.sidste_besked && (
                          <span className="mt-1 block break-words text-sm text-tekst-daempet">
                            {s.sidste_besked.fra_staff ? "" : "Dig: "}
                            {forkort(s.sidste_besked.tekst)}
                          </span>
                        )}
                        <span className="mt-1 block text-[12px] text-tekst-svag">
                          {beskedTid(s.sidste_besked?.oprettet_kl ?? s.aabnet_kl)}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="handler-overskrift" className="mt-10">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="handler-overskrift" className="font-serif text-xl font-semibold text-tekst">
              Handler
            </h2>
            <Link href="/mine-handler" className="inline-flex min-h-11 items-center rounded-md text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
              Mine handler →
            </Link>
          </div>
          {handelFejl ? (
            <p role="alert" className="mt-3 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
              Dine handler kunne ikke hentes. Prøv igen om lidt.
            </p>
          ) : sorteret.length === 0 ? (
            <p className="mt-3 rounded-[14px] border border-kant p-5 text-sm text-tekst-daempet">
              Du har ingen handler endnu. Når du vinder eller sælger noget, kan du skrive med den anden part her.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {sorteret.map((h) => {
                const b = sidste.get(h.id);
                const erKoeber = h.buyer_id === user.id;
                let forhaandsvisning = "Ingen beskeder endnu.";
                if (b) {
                  const tekst = fjernFaellesPraefiks(b.content, b.fra_bidhamr);
                  const fra = b.fra_bidhamr ? "BidHamr: " : b.sender_id === user.id ? "Dig: " : "";
                  forhaandsvisning = fra + forkort(tekst);
                }
                return (
                  <li key={h.id}>
                    <Link
                      href={`/mine-handler/${h.id}`}
                      className="block rounded-[14px] border border-kant bg-white p-4 transition-colors hover:border-kant-staerk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                    >
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate text-[15px] font-medium text-tekst">
                          {h.auctions?.titel ?? "Slettet auktion"}
                        </span>
                        <span className="shrink-0 text-[12px] text-tekst-svag">
                          {erKoeber ? "Du er køber" : "Du er sælger"}
                        </span>
                      </span>
                      <span className="mt-1 block break-words text-sm text-tekst-daempet">
                        {forhaandsvisning}
                      </span>
                      {b && (
                        <span className="mt-1 block text-[12px] text-tekst-svag">
                          {beskedTid(b.created_at)}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
