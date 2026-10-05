// Tallene fra admin_forside_tal() (supabase/migrations/20261005030000_admin_forside.sql,
// rettet i 20261005031000_admin_forside_rettelser.sql).
// Kun antal - ingen beløb og ingen personoplysninger.

export type HandlingTal = {
  aabne_sager: number;
  retur_udloebet: number;
  anker: number;
  rapporter: number;
  ikke_sendt: number;
  ikke_modtaget: number;
  afhentning: number;
  ubetalte: number;
  betalinger: number;
  overfoersel_fejlet: number;
  refusion_fejlet: number;
  afvigelser: number;
  udbetalingskonti: number;
  kontolukninger: number;
};

export type PeriodeTal = { i_dag: number; uge: number; maaned: number };

export type TilvaekstDag = { dag: string; nye: number; kumulativt: number };

export type ForsideTal = {
  handling: HandlingTal;
  brugere: PeriodeTal & { i_alt: number };
  tilvaekst: TilvaekstDag[];
  aktivitet: { auktioner: PeriodeTal; solgte: PeriodeTal };
};

function tal(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function periode(v: unknown): PeriodeTal {
  const o = obj(v);
  return { i_dag: tal(o.i_dag), uge: tal(o.uge), maaned: tal(o.maaned) };
}

const HANDLING_NOEGLER: (keyof HandlingTal)[] = [
  "aabne_sager",
  "retur_udloebet",
  "anker",
  "rapporter",
  "ikke_sendt",
  "ikke_modtaget",
  "afhentning",
  "ubetalte",
  "betalinger",
  "overfoersel_fejlet",
  "refusion_fejlet",
  "afvigelser",
  "udbetalingskonti",
  "kontolukninger",
];

// Svaret fra databasen tolkes defensivt: manglende felter bliver 0.
export function tolkForsideTal(data: unknown): ForsideTal {
  const rod = obj(data);
  const h = obj(rod.handling);
  const handling = Object.fromEntries(HANDLING_NOEGLER.map((k) => [k, tal(h[k])])) as HandlingTal;
  const b = obj(rod.brugere);
  const a = obj(rod.aktivitet);
  const tilvaekst = (Array.isArray(rod.tilvaekst) ? rod.tilvaekst : []).map((r) => {
    const o = obj(r);
    return {
      dag: typeof o.dag === "string" ? o.dag : "",
      nye: tal(o.nye),
      kumulativt: tal(o.kumulativt),
    };
  });
  return {
    handling,
    brugere: { i_alt: tal(b.i_alt), ...periode(b) },
    tilvaekst,
    aktivitet: { auktioner: periode(a.auktioner), solgte: periode(a.solgte) },
  };
}
