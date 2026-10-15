// En lille falsk Supabase-klient til enhedstest af route handlers: hver
// forespørgsel (from(...)...) registreres og besvares af en handler, som
// testen selv skriver. Ingen database, intet netværk.

export type Forespoergsel = {
  tabel: string;
  handling: "select" | "insert" | "update" | "delete" | "upsert";
  kolonner?: string;
  vaerdi?: unknown;
  filtre: [string, ...unknown[]][];
};

export type Svar = { data: unknown; error: { code?: string; message: string } | null };
export type Handler = (q: Forespoergsel) => Svar | undefined;

export function falskKlient(handler: Handler, rpc?: (navn: string, args: unknown) => Svar) {
  const log: Forespoergsel[] = [];
  const rpcLog: { navn: string; args: unknown }[] = [];
  function from(tabel: string) {
    const q: Forespoergsel = { tabel, handling: "select", filtre: [] };
    const svar = () => {
      log.push(q);
      return handler(q) ?? { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select(k?: string) {
        if (q.handling === "select") q.kolonner = k;
        return b;
      },
      insert(v: unknown) {
        q.handling = "insert";
        q.vaerdi = v;
        return b;
      },
      upsert(v: unknown) {
        q.handling = "upsert";
        q.vaerdi = v;
        return b;
      },
      update(v: unknown) {
        q.handling = "update";
        q.vaerdi = v;
        return b;
      },
      delete() {
        q.handling = "delete";
        return b;
      },
      maybeSingle: async () => svar(),
      single: async () => svar(),
      then(res: (v: Svar) => unknown, rej?: (e: unknown) => unknown) {
        return Promise.resolve(svar()).then(res, rej);
      },
    };
    for (const f of ["eq", "neq", "or", "in", "is", "lt", "gt", "not", "order", "limit", "match"]) {
      b[f] = (...args: unknown[]) => {
        q.filtre.push([f, ...args]);
        return b;
      };
    }
    return b;
  }
  const klient = {
    from,
    rpc: async (navn: string, args: unknown) => {
      rpcLog.push({ navn, args });
      return rpc ? rpc(navn, args) : { data: null, error: null };
    },
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
  };
  return { klient, log, rpcLog };
}

export function filter(q: Forespoergsel, navn: string, kolonne: string): unknown {
  return q.filtre.find((f) => f[0] === navn && f[1] === kolonne)?.[2];
}
