import "server-only";

// Lille klient til Dineros API (https://api.dinero.dk/openapi/index.html).
// Kun server-kode - nøglerne kommer fra miljøvariabler (konfig.ts) og må
// aldrig nå klienten eller logges.
//
// Adgang: "personlig integration" til egen virksomhed
// (https://developer.dinero.dk/documentation/personal-integration/):
//   POST https://authz.dinero.dk/dineroapi/oauth/token
//   Authorization: Basic base64(client_id:client_secret)
//   grant_type=password, scope="read write", username = password = API-nøglen
// Tokenet gælder 1 time. Højst 60 kald i minuttet (ellers 429).
//
// Idempotens: kontakter, fakturaer, kreditnotaer og kassekladder oprettes
// med VORES guid. Dinero svarer 400 "guidMustBeUnique" (kontakt) eller 409
// "Duplicated entity" (faktura/kreditnota/kladde), når guiden findes - det
// tolkes som "findes allerede" (verificeret i sandkassen 9. okt. 2026).
// Betalinger har ingen egen guid: kalderen tjekker først, om en betaling med
// samme ExternalReference findes.

export type DineroKonfig = {
  clientId: string;
  clientSecret: string;
  apiKey: string;
  orgId: string;
};

const API = "https://api.dinero.dk";
const AUTH = "https://authz.dinero.dk/dineroapi/oauth/token";
const TIMEOUT_MS = 20_000;

export class DineroFejl extends Error {
  status: number;
  kode: number | null;
  // Netværk, timeout, 5xx, forældet tidsstempel: prøv igen senere.
  forbigaaende: boolean;
  // 429: Dineros grænse på 60 kald i minuttet - vent, uden at det tæller.
  graense: boolean;
  // Adgangen virker ikke (token/nøgler) - stop kørslen.
  adgang: boolean;
  constructor(
    besked: string,
    o: { status: number; kode?: number | null; forbigaaende?: boolean; graense?: boolean; adgang?: boolean },
  ) {
    super(besked);
    this.name = "DineroFejl";
    this.status = o.status;
    this.kode = o.kode ?? null;
    this.forbigaaende = o.forbigaaende ?? false;
    this.graense = o.graense ?? false;
    this.adgang = o.adgang ?? false;
  }
}

type FejlKrop = {
  code?: number;
  message?: string;
  validationErrors?: Record<string, string> | null;
  errorMessageList?: { Code?: string; Message?: string }[] | null;
};

// Valideringsfejlens koder (fx "guidMustBeUnique").
function valideringsKoder(krop: FejlKrop | null): string[] {
  if (!krop) return [];
  const k = new Set<string>();
  for (const [n, v] of Object.entries(krop.validationErrors ?? {})) {
    k.add(n);
    if (typeof v === "string") k.add(v);
  }
  for (const e of krop.errorMessageList ?? []) {
    if (e.Code) k.add(e.Code);
    if (e.Message) k.add(e.Message);
  }
  return [...k];
}

function fejlTekst(krop: FejlKrop | null, raa: string): string {
  if (!krop) return raa.slice(0, 300);
  const v = Object.entries(krop.validationErrors ?? {})
    .map(([n, t]) => `${n}: ${t}`)
    .join("; ");
  return [krop.message, v].filter(Boolean).join(" - ").slice(0, 500);
}

// Tokens pr. nøglesæt i hukommelsen (serverless-instansen). Udløber 5 min
// før Dinero siger.
const tokens = new Map<string, { token: string; udloeber: number }>();

export type DineroKlient = ReturnType<typeof lavDineroKlient>;

export function lavDineroKlient(k: DineroKonfig, o: { maksKald?: number } = {}) {
  const noegle = `${k.clientId}:${k.orgId}`;
  let kald = 0;
  const maksKald = o.maksKald ?? 45;

  async function hentToken(tving = false): Promise<string> {
    const c = tokens.get(noegle);
    if (!tving && c && c.udloeber > Date.now()) return c.token;
    kald++;
    let svar: Response;
    try {
      svar = await fetch(AUTH, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${k.clientId}:${k.clientSecret}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "password", scope: "read write", username: k.apiKey, password: k.apiKey }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (err) {
      throw new DineroFejl(`Dinero-login svarede ikke (${err instanceof Error ? err.name : "fejl"})`, {
        status: 0,
        forbigaaende: true,
      });
    }
    if (svar.status === 429) throw new DineroFejl("Dinero-login: for mange kald", { status: 429, graense: true });
    if (svar.status >= 500) throw new DineroFejl(`Dinero-login svarede ${svar.status}`, { status: svar.status, forbigaaende: true });
    const krop = (await svar.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!svar.ok || !krop?.access_token) {
      // Aldrig svaret i fejlen (kan indeholde detaljer om nøglerne).
      throw new DineroFejl(`Dinero-login afvist (${svar.status}) - kontrollér DINERO_*-nøglerne`, {
        status: svar.status,
        adgang: true,
      });
    }
    const levetid = Math.max(60, Number(krop.expires_in ?? 3600) - 300) * 1000;
    tokens.set(noegle, { token: krop.access_token, udloeber: Date.now() + levetid });
    return krop.access_token;
  }

  async function kaldApi(
    metode: "GET" | "POST" | "PUT",
    sti: string,
    krop?: unknown,
    o2: { accept?: string; formular?: FormData } = {},
  ): Promise<{ status: number; json: unknown; bytes: Uint8Array | null }> {
    const url = `${API}/${sti.replace("{org}", encodeURIComponent(k.orgId))}`;
    const accept = o2.accept ?? "application/json";
    for (let forsoeg = 0; forsoeg < 2; forsoeg++) {
      const token = await hentToken(forsoeg > 0);
      kald++;
      let svar: Response;
      try {
        svar = await fetch(url, {
          method: metode,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: accept,
            ...(krop !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: o2.formular ?? (krop !== undefined ? JSON.stringify(krop) : undefined),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
      } catch (err) {
        throw new DineroFejl(
          `Dinero ${metode} ${sti} svarede ikke (${err instanceof Error ? err.name : "fejl"})`,
          { status: 0, forbigaaende: true },
        );
      }
      if (svar.status === 401 && forsoeg === 0) continue; // token udløbet - nyt token
      if (svar.status === 429) {
        throw new DineroFejl(`Dinero ${metode} ${sti}: for mange kald (60 i minuttet)`, { status: 429, graense: true });
      }
      if (svar.ok && accept !== "application/json") {
        return { status: svar.status, json: null, bytes: new Uint8Array(await svar.arrayBuffer()) };
      }
      const raa = await svar.text();
      let json: unknown = null;
      try {
        json = raa ? JSON.parse(raa) : null;
      } catch {
        json = null;
      }
      if (svar.ok) return { status: svar.status, json, bytes: null };
      const fk = (json && typeof json === "object" ? json : null) as FejlKrop | null;
      const fejl = new DineroFejl(`Dinero ${metode} ${sti} svarede ${svar.status}: ${fejlTekst(fk, raa)}`, {
        status: svar.status,
        kode: typeof fk?.code === "number" ? fk.code : null,
        // 5xx og "timestamp outdated" (kode 58) kan lykkes ved næste forsøg.
        forbigaaende: svar.status >= 500 || fk?.code === 58,
        adgang: svar.status === 401 || svar.status === 403,
      });
      (fejl as DineroFejl & { koder?: string[] }).koder = valideringsKoder(fk);
      throw fejl;
    }
    throw new DineroFejl(`Dinero ${metode} ${sti}: adgang afvist`, { status: 401, adgang: true });
  }

  function koder(err: unknown): string[] {
    return (err as { koder?: string[] })?.koder ?? [];
  }

  // Findes ikke: kontakter giver 404, men fakturaer og kreditnotaer giver 400
  // med kode 63 "Invalid InvoiceGuid/CreditNoteGuid, no results found"
  // (verificeret i sandkassen 9. okt. 2026).
  async function hentEllerNull<T>(sti: string): Promise<T | null> {
    try {
      return (await kaldApi("GET", sti)).json as T;
    } catch (err) {
      if (err instanceof DineroFejl) {
        if (err.status === 404) return null;
        if (err.status === 400 && (err.kode === 63 || /no results found/i.test(err.message))) return null;
      }
      throw err;
    }
  }

  // Opret med egen guid. "oprettet" eller "findes" (samme guid fandtes).
  async function opretMedGuid(sti: string, krop: unknown): Promise<"oprettet" | "findes"> {
    try {
      await kaldApi("POST", sti, krop);
      return "oprettet";
    } catch (err) {
      if (err instanceof DineroFejl) {
        if (err.status === 409 || err.kode === 72) return "findes";
        if (err.status === 400 && koder(err).includes("guidMustBeUnique")) return "findes";
      }
      throw err;
    }
  }

  return {
    orgId: k.orgId,
    antalKald: () => kald,
    budgetOpbrugt: (reserve = 0) => kald + reserve >= maksKald,

    // ---------------------------------------------------------------- kontakter
    hentKontakt: (guid: string) => hentEllerNull<DineroKontakt>(`v1/{org}/contacts/${guid}`),
    opretKontakt: (m: DineroKontaktModel & { ContactGuid: string }) => opretMedGuid("v1/{org}/contacts", m),
    opdaterKontakt: async (guid: string, m: DineroKontaktModel) => {
      await kaldApi("PUT", `v1/{org}/contacts/${guid}`, m);
    },

    // ---------------------------------------------------------------- fakturaer
    hentFaktura: (guid: string) => hentEllerNull<DineroBilag>(`v1/{org}/invoices/${guid}`),
    opretFaktura: (m: DineroBilagModel & { Guid: string }) => opretMedGuid("v1/{org}/invoices", m),
    bogfoerFaktura: async (guid: string, tidsstempel: string) =>
      (await kaldApi("POST", `v1/{org}/invoices/${guid}/book`, { Timestamp: tidsstempel })).json as DineroBilag,
    hentFakturaBetalinger: async (guid: string) =>
      (await kaldApi("GET", `v2/{org}/invoices/${guid}/payments`)).json as DineroBetalinger,
    registrerFakturaBetaling: async (guid: string, m: DineroBetalingModel) => {
      await kaldApi("POST", `v1/{org}/invoices/${guid}/payments`, m);
    },
    hentFakturaPdf: async (guid: string) =>
      (await kaldApi("GET", `v1/{org}/invoices/${guid}`, undefined, { accept: "application/octet-stream" })).bytes,

    // ---------------------------------------------------------------- kreditnotaer
    hentKreditnota: (guid: string) => hentEllerNull<DineroBilag>(`v1/{org}/sales/creditnotes/${guid}`),
    opretKreditnota: (m: DineroBilagModel & { Guid: string; CreditNoteFor: string }) =>
      opretMedGuid("v1/{org}/sales/creditnotes", m),
    bogfoerKreditnota: async (guid: string, tidsstempel: string) =>
      (await kaldApi("POST", `v1/{org}/sales/creditnotes/${guid}/book`, { Timestamp: tidsstempel })).json as DineroBilag,
    hentKreditnotaPdf: async (guid: string) =>
      (await kaldApi("GET", `v1/{org}/sales/creditnotes/${guid}/pdf`, undefined, { accept: "application/octet-stream" }))
        .bytes,

    // ---------------------------------------------------------------- kassekladde (finansbilag)
    // null = findes ikke (Dinero svarer 400 "ledgerItemNotFound").
    kladdeStatus: async (id: string): Promise<DineroKladdeStatus | null> => {
      try {
        const r = (await kaldApi("POST", "v1/{org}/ledgeritems/status", [{ Id: id }])).json as DineroKladdeStatus[];
        return r?.find((x) => x.Id === id) ?? null;
      } catch (err) {
        if (err instanceof DineroFejl && err.status === 400 && koder(err).includes("ledgerItemNotFound")) return null;
        throw err;
      }
    },
    opretKladde: (m: DineroKladdeModel) => opretMedGuid("v1.2/{org}/ledgeritems", [m]),
    bogfoerKladde: async (id: string, version: string) => {
      await kaldApi("POST", "v1/{org}/ledgeritems/book", [{ Id: id, Version: version }]);
    },

    // ---------------------------------------------------------------- filer (bilag)
    uploadPdf: async (filnavn: string, indhold: Uint8Array): Promise<string> => {
      const fd = new FormData();
      fd.append("file", new Blob([indhold as BlobPart], { type: "application/pdf" }), filnavn);
      const r = (await kaldApi("POST", "v1/{org}/files", undefined, { formular: fd })).json as { FileGuid?: string };
      if (!r?.FileGuid) throw new DineroFejl("Dinero gav intet fil-id for bilaget", { status: 200, forbigaaende: true });
      return r.FileGuid;
    },
  };
}

// ---------------------------------------------------------------- typer

export type DineroKontaktModel = {
  ExternalReference?: string | null;
  Name: string;
  Street?: string | null;
  ZipCode?: string | null;
  City?: string | null;
  CountryKey: "DK";
  Email?: string | null;
  VatNumber?: string | null;
  IsPerson: boolean;
  IsMember: false;
  UseCvr: false;
};

export type DineroKontakt = DineroKontaktModel & { ContactGuid: string; DeletedAt: string | null };

export type DineroLinjeModel = {
  Description: string;
  Quantity: 1;
  AccountNumber: number;
  BaseAmountValue: number;
  Discount: 0;
  Unit: string;
  LineType: "Product";
};

export type DineroBilagModel = {
  ContactGuid: string;
  ShowLinesInclVat: true;
  Currency: "DKK";
  Language: "da-DK";
  ExternalReference: string;
  Description?: string;
  Comment?: string | null;
  Date: string;
  PaymentConditionType?: "Paid";
  Address?: string | null;
  ProductLines: DineroLinjeModel[];
};

export type DineroBilag = {
  Guid: string;
  ContactGuid: string | null;
  Status: "Draft" | "Booked" | string;
  PaymentStatus?: string | null;
  TimeStamp: string;
  Number: number;
  TotalInclVat: number;
  TotalVat: number;
  Currency?: string | null;
  ShowLinesInclVat: boolean;
  DeletedAt?: string | null;
  CreditNoteFor?: string | null;
  ProductLines: { BaseAmountValueInclVat: number; AccountNumber: number }[];
};

export type DineroBetalingModel = {
  Timestamp: string;
  DepositAccountNumber: number;
  RemainderIsFee: false;
  ExternalReference: string;
  PaymentDate: string;
  Description: string;
  Amount: number;
};

export type DineroBetalinger = {
  Payments: { ExternalReference: string | null; Amount: number; PaymentClass?: string }[];
  RemainingAmount: number;
  PaidAmount: number;
};

export type DineroKladdeModel = {
  Id: string;
  VoucherDate: string;
  FileGuid?: string | null;
  Lines: {
    Description: string;
    Amount: number;
    AccountNumber: number;
    BalancingAccountNumber: number;
  }[];
};

export type DineroKladdeStatus = {
  Id: string;
  Status: "Draft" | "PendingBooking" | "Booked" | string;
  VoucherNumber: number | null;
  Version: string | null;
};
