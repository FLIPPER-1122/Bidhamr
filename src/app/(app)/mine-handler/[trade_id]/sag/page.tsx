import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { hentSagMuligheder } from "@/app/actions/sager";
import MeldProblemFlow from "@/components/sager/meld/MeldProblemFlow";
import SagVareKort from "@/components/sager/meld/SagVareKort";
import { sagTid } from "@/components/sager/visning";
import { hentBruger } from "@/lib/supabase/bruger";
import { hentSagSideHandel, sagFristVisning } from "@/lib/sagSide";
import { SAG_FLOW, sagUdfyld } from "@/lib/tekster/sagValg";
import type { SagMuligheder } from "@/lib/sagMuligheder";

// "Meld et problem" - køberens 4 trin (showcase/opret-sag-showcase.html).
// Indgange: "Der er et problem med varen" på handelssiden og linket
// ?meld=problem fra beskeden om, at pakken er leveret (page.tsx sender hertil).
// Mulighederne kommer fra hentSagMuligheder (samme kode som appens endpoint).

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Meld et problem", robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function MeldProblemPage({ params }: { params: Promise<{ trade_id: string }> }) {
  const { trade_id } = await params;
  const handelSti = `/mine-handler/${encodeURIComponent(trade_id)}`;
  const user = await hentBruger();
  if (!user) redirect(`/login?redirect=${handelSti}/sag`);
  if (!UUID.test(trade_id)) notFound();

  const handel = await hentSagSideHandel(trade_id, user.id);
  // Sælgeren (eller en anden) hører til på handelssiden.
  if (!handel) redirect(handelSti);

  const m = await hentSagMuligheder(trade_id);
  if ("fejl" in m) throw new Error(m.fejl);
  // Der er allerede en sag: vis den.
  if (m.harSag) redirect(`${handelSti}#sag`);

  // Fristen vises kun efter levering (mens pakken er på vej er "fristen" den
  // automatiske frigivelse, og den forvirrer - showcasens skærm 0).
  const frist = m.fristEfterLevering ? sagFristVisning(m.fristKl) : null;

  if (!m.kanOprettes) {
    return <IkkeMulig m={m} handelSti={handelSti} vare={handel.vare} erhverv={handel.erhverv} />;
  }

  return (
    <main className="flex-1 bg-[#FAFAFA]">
      <MeldProblemFlow
        tradeId={trade_id}
        koeberId={user.id}
        valg={m.valg}
        kraeverBeskyttelse={m.kraeverBeskyttelse}
        erhverv={handel.erhverv}
        vare={handel.vare}
        frist={frist}
        handelSti={handelSti}
      />
    </main>
  );
}

// Hvorfor kan der ikke oprettes en sag? (Uden for komponenten: læser uret.)
function ikkeMuligTekst(m: SagMuligheder, erhverv: boolean): { udloebet: boolean; tekst: string } {
  const t = SAG_FLOW.ikkeMulig;
  const nu = Date.now();
  if (m.fristEfterLevering && m.fristKl && Date.parse(m.fristKl) <= nu) {
    return { udloebet: true, tekst: sagUdfyld(t.udloebet, { dato: sagTid(m.fristKl) }) };
  }
  if (m.bortkommetFraKl && Date.parse(m.bortkommetFraKl) > nu) {
    return { udloebet: false, tekst: sagUdfyld(t.forTidligt, { dato: sagTid(m.bortkommetFraKl) }) };
  }
  if (m.kraeverBeskyttelse.length > 0 && erhverv) {
    return { udloebet: false, tekst: SAG_FLOW.handel.kraeverBeskyttelseErhverv };
  }
  return { udloebet: false, tekst: t.generelt };
}

function IkkeMulig({
  m,
  handelSti,
  vare,
  erhverv,
}: {
  m: SagMuligheder;
  handelSti: string;
  vare: Parameters<typeof SagVareKort>[0]["vare"];
  erhverv: boolean;
}) {
  const t = SAG_FLOW.ikkeMulig;
  const { udloebet, tekst } = ikkeMuligTekst(m, erhverv);
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-6 pb-10 sm:px-6">
      <h1 className="text-2xl leading-tight sm:text-[30px]">{SAG_FLOW.titel}</h1>
      <div role="status" className="mt-5 border border-advarsel-kant bg-advarsel-bg p-5 text-advarsel-tekst">
        <h2 className="text-[17px] font-semibold">{udloebet ? SAG_FLOW.handel.udloebetTitel : t.titel}</h2>
        <p className="mt-1 text-[15px]">{tekst}</p>
      </div>
      <div className="mt-5">
        <SagVareKort vare={vare} frist={null} />
      </div>
      <Link href={handelSti} className="btn btn-sekundaer btn-stor mt-6 w-full sm:w-auto">
        {t.tilbage}
      </Link>
    </main>
  );
}
