import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Ikon from "@/components/Ikon";
import SagVareKort from "@/components/sager/meld/SagVareKort";
import { sagTid } from "@/components/sager/visning";
import { createClient } from "@/lib/supabase/server";
import { hentBruger } from "@/lib/supabase/bruger";
import { hentSagSideHandel } from "@/lib/sagSide";
import { SAG_ANKEFRIST_DAGE, SAG_SVAR_FRIST_TIMER, sagSvarFristKl, type SagType } from "@/lib/sager";
import { SAG_FLOW, SAG_KVITTERING, SAG_VALG, SAG_VALG_IDER, erSagValgId, sagUdfyld } from "@/lib/tekster/sagValg";

// Kvitteringen efter "Send til BidHamr": det skal køberen gøre nu, og
// hvordan sagen går videre (med frister). ?valg= er køberens valg i trin 1
// (kun til teksten "Det skal du gøre nu" - sagen selv er allerede oprettet).

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sagen er sendt", robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SagSendtPage({
  params,
  searchParams,
}: {
  params: Promise<{ trade_id: string }>;
  searchParams: Promise<{ valg?: string }>;
}) {
  const [{ trade_id }, { valg }] = await Promise.all([params, searchParams]);
  const handelSti = `/mine-handler/${encodeURIComponent(trade_id)}`;
  const user = await hentBruger();
  if (!user) redirect(`/login?redirect=${handelSti}`);
  if (!UUID.test(trade_id)) notFound();

  const handel = await hentSagSideHandel(trade_id, user.id);
  if (!handel) redirect(handelSti);

  const supabase = await createClient();
  const { data: sag, error } = await supabase
    .from("sager")
    .select("id, type, oprettet_kl")
    .eq("trade_id", trade_id)
    .order("oprettet_kl", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; type: SagType; oprettet_kl: string }>();
  if (error) throw new Error(`Sagen kunne ikke hentes: ${error.message}`);
  if (!sag) redirect(`${handelSti}/sag`);

  // Valget skal passe til sagens type; ellers det første valg med typen.
  const v =
    erSagValgId(valg) && SAG_VALG[valg].type === sag.type
      ? SAG_VALG[valg]
      : SAG_VALG[SAG_VALG_IDER.find((i) => SAG_VALG[i].type === sag.type) ?? "andet"];
  const svarFrist = sagSvarFristKl(sag.oprettet_kl);
  const k = SAG_FLOW.kvittering;
  const videre = [
    sagUdfyld(k.trin[0], { timer: SAG_SVAR_FRIST_TIMER, dato: svarFrist ? sagTid(svarFrist) : "" }),
    k.trin[1],
    sagUdfyld(k.trin[2], { dage: SAG_ANKEFRIST_DAGE }),
  ];

  return (
    <main className="flex-1 bg-[#FAFAFA]">
      <div className="mx-auto w-full max-w-5xl px-4 pt-6 pb-10 sm:px-6 lg:px-8 lg:pb-12">
        <div className="lg:grid lg:grid-cols-[minmax(0,640px)_340px] lg:items-start lg:gap-10">
          <div className="border border-kant bg-white px-4 pb-6 pt-8 sm:px-6">
            <div className="flex flex-col items-center text-center">
              <span className="grid h-[76px] w-[76px] place-items-center rounded-full bg-groen text-white">
                <Ikon navn="flueben" className="h-10 w-10" strøg={2.5} />
              </span>
              <h1 className="mt-4 text-2xl leading-tight sm:text-[28px]">{SAG_KVITTERING.titel}</h1>
              <p className="mt-1.5 max-w-sm text-[15px] text-tekst-daempet">{SAG_KVITTERING.tekst}</p>
            </div>

            <div className="mt-6 border border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst">
              <h2 className="text-[15px] font-semibold">{k.goerNu}</h2>
              <p className="mt-1 text-sm">{v.goerNu}</p>
            </div>

            <h2 className="mt-6 text-[17px] font-semibold text-tekst">{k.videre}</h2>
            <ol className="mt-3 grid gap-3">
              {videre.map((t, i) => (
                <li key={t} className="flex gap-3 text-[15px] leading-snug">
                  <span
                    className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-groen text-[13px] font-bold text-white"
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <span className="pt-0.5">{t}</span>
                </li>
              ))}
            </ol>

            <Link href={`${handelSti}#sag`} className="btn btn-primaer btn-stor mt-7 w-full lg:w-auto lg:min-w-60">
              {k.seSag}
            </Link>
          </div>
          <div className="mt-5 lg:mt-0">
            <SagVareKort vare={handel.vare} frist={null} />
          </div>
        </div>
      </div>
    </main>
  );
}
