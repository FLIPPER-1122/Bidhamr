import "server-only";

// Hvilke sager kan køberen oprette lige nu? Fælles for hjemmesiden
// (src/app/actions/sager.ts hentSagMuligheder) og appen
// (POST /api/sag/app/muligheder - docs/APP-ENDPOINTS.md), så appen ikke selv
// regner det ud. Databasen (sag_opret) er stadig den endelige dommer.
//
// brugerId SKAL være verificeret af kalderen (session eller Bearer-token).
// Kun køberen på handlen får mulighederne; alle andre får "Handlen findes ikke".
import { createAdminClient } from "@/lib/supabase/admin";
import type { Prismodel } from "@/lib/betaling/beregn";
import {
  SAG_AUTO_FRIGIV_EFTER_DAGE,
  SAG_BORTKOMMET_EFTER_DAGE,
  type SagType,
  sagKraeverBeskyttelse,
  sagProblemFristKl,
} from "@/lib/sager";
import {
  sagBilledKrav,
  sagHvisDuFaarRet,
  sagValgFor,
  type SagBilledKrav,
  type SagValgId,
} from "@/lib/tekster/sagValg";

const DAG = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Et valg i trin 1 med alt, skærmene skal bruge (tekster fra sagValg.ts).
export type SagValgMulighed = {
  id: SagValgId;
  navn: string;
  undertekst: string;
  type: SagType;
  retur: boolean;
  // Billederne i trin 2 (tom = trinnet springes over).
  billeder: SagBilledKrav[];
  // "Pakken er smidt ud" kan vælges (pakkebilledet kræves).
  smidtUdMulig: boolean;
  tekstforslag: string[];
  hvisDuFaarRet: string;
  goerNu: string;
};

export type SagMuligheder = {
  // Kan der oprettes en sag lige nu (mindst ét valg)?
  kanOprettes: boolean;
  // Typer, køberen kan vælge lige nu (tom = ingen sag mulig).
  typer: SagType[];
  // Typer, der kræver BidHamr Beskyttelse, som køberen ikke har.
  kraeverBeskyttelse: SagType[];
  beskyttelse: boolean;
  // Billeder af pakken (med label) og indholdet kræves (pakken er modtaget).
  billederKraeves: boolean;
  // Typer, der ikke kræver billederne, selvom billederKraeves er sat
  // ("Pakken er ikke kommet frem", når fragtfirmaet har meldt den leveret).
  billederFriTyper: SagType[];
  // Fragtfirmaets leveringsmelding startede uret (trades.modtaget_kilde).
  fragtLeveret: boolean;
  // Sidste frist for at oprette en sag: fristen efter levering
  // (trades.problem_frist_kl - 72 t; 48 t for ældre handler), eller - når
  // pakken er sendt - 14 dage efter afsendelse.
  fristKl: string | null;
  // Fristen gælder levering (true) eller pakken på vej (false/null).
  fristEfterLevering: boolean;
  // Hvornår "Pakken er ikke kommet frem" kan vælges (pakke sendt).
  bortkommetFraKl: string | null;
  // Der findes allerede en sag (så vises den i stedet).
  harSag: boolean;
  // Valgene i trin 1 - i showcasens rækkefølge.
  valg: SagValgMulighed[];
};

export function tommeMuligheder(): SagMuligheder {
  return {
    kanOprettes: false,
    typer: [],
    kraeverBeskyttelse: [],
    beskyttelse: false,
    billederKraeves: false,
    billederFriTyper: [],
    fragtLeveret: false,
    fristKl: null,
    fristEfterLevering: false,
    bortkommetFraKl: null,
    harSag: false,
    valg: [],
  };
}

type Handel = {
  buyer_id: string;
  status: string;
  received_at: string | null;
  sendt_kl: string | null;
  modtaget_kilde?: string | null;
  problem_frist_kl?: string | null;
};

type Betaling = {
  status: string;
  beskyttelse: boolean;
  betalt_kl: string | null;
  frigivet_kl: string | null;
  refusion_anmodet_kl: string | null;
  overfoersel_paabegyndt_kl: string | null;
  stripe_transfer_id: string | null;
  prismodel?: Prismodel | null;
  bud_oere: number;
  total_oere: number;
  beskyttelse_oere: number | null;
  fragt_oere: number | null;
};

export async function hentSagMulighederFor(
  brugerId: string,
  tradeId: string,
): Promise<SagMuligheder | { fejl: string; kode: "ikke_fundet" }> {
  if (!UUID.test(tradeId)) return { fejl: "Handlen findes ikke.", kode: "ikke_fundet" };
  const admin = createAdminClient();

  const hentHandel = async () => {
    const hent = (k: string) => admin.from("trades").select(k).eq("id", tradeId).maybeSingle<Handel>();
    // Ældre databaser: problem_frist_kl (20261102210000) og modtaget_kilde
    // (20261030010000) findes måske ikke.
    let r = await hent("buyer_id, status, received_at, sendt_kl, modtaget_kilde, problem_frist_kl");
    if (r.error?.code === "42703") r = await hent("buyer_id, status, received_at, sendt_kl, modtaget_kilde");
    if (r.error?.code === "42703") r = await hent("buyer_id, status, received_at, sendt_kl");
    if (r.error) throw new Error(`trades: ${r.error.message}`);
    return r.data;
  };
  const hentBetaling = async () => {
    const k =
      "status, beskyttelse, betalt_kl, frigivet_kl, refusion_anmodet_kl, overfoersel_paabegyndt_kl, stripe_transfer_id, bud_oere, total_oere, beskyttelse_oere, fragt_oere";
    let r = await admin.from("betalinger").select(`${k}, prismodel`).eq("trade_id", tradeId).maybeSingle<Betaling>();
    if (r.error?.code === "42703") r = await admin.from("betalinger").select(k).eq("trade_id", tradeId).maybeSingle<Betaling>();
    if (r.error) throw new Error(`betalinger: ${r.error.message}`);
    return r.data;
  };

  const [t, b, { count, error: sFejl }] = await Promise.all([
    hentHandel(),
    hentBetaling(),
    admin.from("sager").select("id", { count: "exact", head: true }).eq("trade_id", tradeId),
  ]);
  if (sFejl) throw new Error(`sager: ${sFejl.message}`);
  if (!t || t.buyer_id !== brugerId) return { fejl: "Handlen findes ikke.", kode: "ikke_fundet" };

  const m = tommeMuligheder();
  m.beskyttelse = !!b?.beskyttelse;
  m.harSag = (count ?? 0) > 0;
  if (!b || m.harSag) return m;
  if (b.status !== "betalt" || b.frigivet_kl || b.refusion_anmodet_kl || b.overfoersel_paabegyndt_kl || b.stripe_transfer_id) {
    return m;
  }

  const nu = Date.now();
  let kandidater: SagType[] = [];
  if (t.status === "modtaget" && t.received_at) {
    const fristIso = sagProblemFristKl(t.received_at, t.problem_frist_kl);
    const frist = fristIso ? Date.parse(fristIso) : 0;
    m.fristKl = fristIso;
    m.fristEfterLevering = true;
    m.billederKraeves = true;
    if (frist > nu) kandidater = ["skadet", "ikke_som_beskrevet", "svindel", "andet"];
    // Fragtfirmaet meldte pakken leveret (20261030010000): køberen kan også
    // melde, at han ikke har fået den - uden billeder (sag_opret).
    if (t.modtaget_kilde === "fragt") {
      m.fragtLeveret = true;
      m.billederFriTyper = ["bortkommet"];
      if (frist > nu) kandidater = ["bortkommet", ...kandidater];
    }
  } else if (t.status === "pakke_sendt") {
    const sendt = t.sendt_kl ?? b.betalt_kl;
    if (sendt) {
      const fra = Date.parse(sendt) + SAG_BORTKOMMET_EFTER_DAGE * DAG;
      // Efter 14 dage frigives pengene automatisk (handel_auto_frigiv).
      const til = Date.parse(sendt) + SAG_AUTO_FRIGIV_EFTER_DAGE * DAG;
      m.bortkommetFraKl = new Date(fra).toISOString();
      m.fristKl = new Date(til).toISOString();
      if (fra <= nu && nu < til) kandidater = ["bortkommet", "svindel"];
    }
  }

  m.typer = kandidater.filter((k) => !sagKraeverBeskyttelse(k) || b.beskyttelse);
  m.kraeverBeskyttelse = kandidater.filter((k) => sagKraeverBeskyttelse(k) && !b.beskyttelse);
  m.kanOprettes = m.typer.length > 0;

  const beloeb = {
    prismodel: b.prismodel ?? null,
    bud_oere: Number(b.bud_oere),
    total_oere: Number(b.total_oere),
    beskyttelse_oere: b.beskyttelse_oere === null ? null : Number(b.beskyttelse_oere),
    // Returfragten = fragten ud (returfragt_start).
    returfragt_oere: b.fragt_oere ? Number(b.fragt_oere) : null,
  };
  m.valg = sagValgFor(m.typer).map((v) => {
    const fri = m.billederFriTyper.includes(v.type);
    const billeder = sagBilledKrav(v, m.billederKraeves && !fri);
    return {
      id: v.id,
      navn: v.navn,
      undertekst: v.type === "bortkommet" && m.fragtLeveret && v.undertekstLeveret ? v.undertekstLeveret : v.undertekst,
      type: v.type,
      retur: v.retur,
      billeder,
      smidtUdMulig: billeder.some((x) => x.kategori === "pakke_label"),
      tekstforslag: v.tekstforslag,
      hvisDuFaarRet: sagHvisDuFaarRet(v, beloeb),
      goerNu: v.goerNu,
    };
  });
  return m;
}
