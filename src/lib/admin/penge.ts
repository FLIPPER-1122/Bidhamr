import "server-only";

// Data til /admin/penge - KUN for rollen chef.
//
// Rollen tjekkes her (assertRole("chef")) FØR noget hentes, uanset hvem der
// kalder funktionen. SQL-funktionerne admin_penge_tal og admin_penge_holdes
// kan kun kaldes med service_role (20261005040000_admin_penge.sql).
//
// Filen er bevidst IKKE en "use server"-fil: der findes ingen server action
// eller route handler for pengetallene, så de kan kun nås ved at rendere
// siden som chef.
//
// Stripe er sandheden om penge. Stripe-kald er kun læsning (balance og
// balance transactions), sker kun her på serveren, caches i 60 sekunder og
// må aldrig vælte siden - en fejl bliver til en besked i afstemningen.

import Stripe from "stripe";
import { notFound } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import { getStripe } from "@/lib/stripe";

// ------------------------------------------------------------ perioder

export const PERIODER = [
  { key: "idag", label: "I dag" },
  { key: "7d", label: "7 dage" },
  { key: "30d", label: "30 dage" },
  { key: "aar", label: "I år" },
  { key: "alt", label: "Alt" },
] as const;

export type PeriodeKey = (typeof PERIODER)[number]["key"];

export function somPeriode(v: unknown): PeriodeKey {
  return PERIODER.some((p) => p.key === v) ? (v as PeriodeKey) : "30d";
}

const TIDSZONE = "Europe/Copenhagen";

// Forskydning (ms) mellem UTC og dansk tid på et givet tidspunkt.
function kbhForskydning(t: Date): number {
  const navn = new Intl.DateTimeFormat("en-US", {
    timeZone: TIDSZONE,
    timeZoneName: "longOffset",
  })
    .formatToParts(t)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(navn ?? "");
  if (!m) return 0;
  const min = Number(m[2]) * 60 + Number(m[3]);
  return (m[1] === "-" ? -1 : 1) * min * 60_000;
}

// Midnat dansk tid på datoen (aar, maaned 1-12, dag), som UTC-tidspunkt.
function kbhMidnat(aar: number, maaned: number, dag: number): Date {
  const utcMidnat = Date.UTC(aar, maaned - 1, dag);
  let gaet = new Date(utcMidnat - kbhForskydning(new Date(utcMidnat)));
  // Sommer-/vintertid kan skifte samme nat - justér én gang.
  gaet = new Date(utcMidnat - kbhForskydning(gaet));
  return gaet;
}

function kbhDato(t: Date): { aar: number; maaned: number; dag: number } {
  const dele = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIDSZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(t);
  const v = (type: string) => Number(dele.find((p) => p.type === type)?.value);
  return { aar: v("year"), maaned: v("month"), dag: v("day") };
}

// Perioden som [fra, til). til = nu, rundet ned til hele minutter, så databasen
// og Stripe ser præcis samme vindue, og cachen kan genbruges i minuttet.
export function periodeInterval(p: PeriodeKey, nu = new Date()): { fra: Date | null; til: Date } {
  const til = new Date(Math.floor(nu.getTime() / 60_000) * 60_000);
  const d = kbhDato(nu);
  switch (p) {
    case "idag":
      return { fra: kbhMidnat(d.aar, d.maaned, d.dag), til };
    case "7d":
      return { fra: new Date(til.getTime() - 7 * 86_400_000), til };
    case "30d":
      return { fra: new Date(til.getTime() - 30 * 86_400_000), til };
    case "aar":
      return { fra: kbhMidnat(d.aar, 1, 1), til };
    case "alt":
      return { fra: null, til };
  }
}

// ------------------------------------------------------------ typer (øre)

type AntalBeloeb = { antal: number; beloeb: number };

export type PengeTal = {
  betalinger_modtaget: AntalBeloeb;
  forkerte_beloeb_modtaget: AntalBeloeb;
  omsaetning: AntalBeloeb;
  indtjening: {
    koebergebyr: number;
    saelgergebyr: number;
    beskyttelse: number;
    oevrigt: number;
    i_alt: number;
    heraf_ikke_frigivet: number;
    antal_beskyttelse: number;
  };
  fragt: AntalBeloeb;
  udbetalinger: AntalBeloeb;
  refusioner: {
    fulde: AntalBeloeb;
    delvise: AntalBeloeb;
    i_gang: AntalBeloeb;
    forkerte_beloeb: AntalBeloeb;
    efter_udbetaling: { antal: number; refunderet: number; udbetalt: number };
  };
  indsigelser: {
    antal: number;
    beloeb: number;
    aabne: number;
    vundet: number;
    lukket: number;
    tabt_foer_udbetaling: AntalBeloeb;
    tabt_efter_udbetaling: AntalBeloeb & { tab: number };
  };
};

export type HoldtGrund =
  | "indsigelse"
  | "refusion_i_gang"
  | "afventer_udbetaling"
  | "udbetaling_paa_vej"
  | "venter_paa_bank"
  | "afventer_anke"
  | "afventer_sag"
  | "afventer_retur"
  | "ankefrist"
  | "frosset"
  | "afhentning"
  | "afventer_afsendelse"
  | "auto_frigivelse"
  | "kraever_tjek";

export type HoldtRaekke = {
  betaling_id: string;
  trade_id: string;
  auction_id: string | null;
  titel: string | null;
  total_oere: number;
  udbetaling_oere: number;
  betalt_kl: string | null;
  handel_status: string;
  grund: HoldtGrund;
  forventet_kl: string | null;
  handling: "frigiv" | "refunder" | "ingen" | null;
  penge_fejl: string | null;
  kraever_opmaerksomhed: boolean;
};

export type PengeHoldes = {
  antal: number;
  beloeb: number;
  til_saelgere: number;
  efter_grund: { grund: HoldtGrund; antal: number; beloeb: number }[];
  forkerte_beloeb: AntalBeloeb;
  liste: HoldtRaekke[];
};

export type StripeBalance = {
  testmiljoe: boolean;
  tilgaengelig: number; // DKK, øre
  afventer: number; // DKK, øre
  andreValutaer: string[];
  hentetKl: string;
};

export type StripeKategori = { antal: number; beloeb: number; gebyr: number };

export type StripeBevaegelser = {
  kategorier: Record<string, StripeKategori>;
  gebyrer: number; // alle Stripe-gebyrer i perioden (fee-felter + kategori 'fee'), positivt tal
  antal: number;
  ufuldstaendig: boolean;
  hentetKl: string;
};

// Saldo-afstemning af sælgernes Stripe-konti (overvågningen, F06): åbne
// tilfælde i drift_tilfaelde (saldo:, saldo-tilgaengelig:, saldo-ingen-adgang:)
// og hvornår overvågningen sidst kørte.
export type SaldoAfstemning = {
  afvigende: number;
  sidstKoertKl: string | null;
};

export type Resultat<T> = { ok: true; data: T } | { ok: false; fejl: string };

export const HOLDT_GRAENSE = 200;

// ------------------------------------------------------------ Stripe (cache 60 s)

const CACHE_MS = 60_000;
const STRIPE_TIMEOUT_MS = 10_000;
// Højst 10 sider à 100 bevægelser pr. periode. Flere = "ufuldstændig".
const MAKS_SIDER = 10;

const cache = new Map<string, { udloeber: number; vaerdi: unknown }>();

async function medCache<T>(noegle: string, hent: () => Promise<T>): Promise<T> {
  const nu = Date.now();
  const fundet = cache.get(noegle);
  if (fundet && fundet.udloeber > nu) return fundet.vaerdi as T;
  const vaerdi = await hent(); // fejl caches ikke
  for (const [k, v] of cache) if (v.udloeber <= nu) cache.delete(k);
  cache.set(noegle, { udloeber: nu + CACHE_MS, vaerdi });
  return vaerdi;
}

function stripeFejl(err: unknown): string {
  if (err instanceof Stripe.errors.StripeError) {
    return `Stripe svarede med en fejl (${err.code ?? err.type}).`;
  }
  if (err instanceof Error && err.message.includes("STRIPE_SECRET_KEY")) {
    return "Stripe-nøglen mangler på serveren.";
  }
  return "Stripe kunne ikke nås.";
}

function erTestnoegle(): boolean {
  return (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");
}

async function hentStripeBalance(): Promise<Resultat<StripeBalance>> {
  try {
    const data = await medCache("balance", async () => {
      const b = await getStripe().balance.retrieve({}, { timeout: STRIPE_TIMEOUT_MS });
      const dkk = (liste: { amount: number; currency: string }[]) =>
        liste.filter((x) => x.currency === "dkk").reduce((s, x) => s + x.amount, 0);
      const andre = new Set(
        [...b.available, ...b.pending]
          .filter((x) => x.currency !== "dkk" && x.amount !== 0)
          .map((x) => x.currency.toUpperCase()),
      );
      return {
        testmiljoe: !b.livemode,
        tilgaengelig: dkk(b.available),
        afventer: dkk(b.pending),
        andreValutaer: [...andre],
        hentetKl: new Date().toISOString(),
      } satisfies StripeBalance;
    });
    return { ok: true, data };
  } catch (err) {
    console.error("Stripe-balance kunne ikke hentes:", err);
    return { ok: false, fejl: stripeFejl(err) };
  }
}

async function hentStripeBevaegelser(
  fra: Date | null,
  til: Date,
): Promise<Resultat<StripeBevaegelser>> {
  const gte = fra ? Math.floor(fra.getTime() / 1000) : undefined;
  const lt = Math.floor(til.getTime() / 1000);
  try {
    const data = await medCache(`bevaegelser:${gte ?? "alt"}:${lt}`, async () => {
      const stripe = getStripe();
      const kategorier: Record<string, StripeKategori> = {};
      let gebyrer = 0;
      let antal = 0;
      let efter: string | undefined;
      let ufuldstaendig = false;
      for (let side = 0; side < MAKS_SIDER; side++) {
        const svar = await stripe.balanceTransactions.list(
          {
            limit: 100,
            currency: "dkk",
            created: gte !== undefined ? { gte, lt } : { lt },
            ...(efter ? { starting_after: efter } : {}),
          },
          { timeout: STRIPE_TIMEOUT_MS },
        );
        for (const t of svar.data) {
          const k = (kategorier[t.reporting_category] ??= { antal: 0, beloeb: 0, gebyr: 0 });
          k.antal += 1;
          k.beloeb += t.amount;
          k.gebyr += t.fee;
          gebyrer += t.fee;
          if (t.reporting_category === "fee") gebyrer -= t.amount; // gebyr = negativt beløb
          antal += 1;
        }
        if (!svar.has_more || svar.data.length === 0) {
          ufuldstaendig = false;
          break;
        }
        efter = svar.data[svar.data.length - 1].id;
        ufuldstaendig = true;
      }
      return {
        kategorier,
        gebyrer,
        antal,
        ufuldstaendig,
        hentetKl: new Date().toISOString(),
      } satisfies StripeBevaegelser;
    });
    return { ok: true, data };
  } catch (err) {
    console.error("Stripe-bevægelser kunne ikke hentes:", err);
    return { ok: false, fejl: stripeFejl(err) };
  }
}

// ------------------------------------------------------------ samlet

export type PengeOversigt = {
  periode: PeriodeKey;
  fra: string | null;
  til: string;
  tal: Resultat<PengeTal>;
  holdes: Resultat<PengeHoldes>;
  balance: Resultat<StripeBalance>;
  bevaegelser: Resultat<StripeBevaegelser>;
  saldo: Resultat<SaldoAfstemning>;
  testnoegle: boolean;
};

export async function hentPengeOversigt(periode: PeriodeKey): Promise<PengeOversigt> {
  // Kun chef. Alle andre (også admin og medarbejder) får 404.
  let admin: Awaited<ReturnType<typeof assertRole>>["admin"];
  try {
    ({ admin } = await assertRole("chef"));
  } catch {
    notFound();
  }

  const { fra, til } = periodeInterval(periode);

  const [talSvar, holdesSvar, balance, bevaegelser, saldoSvar, koerselSvar] = await Promise.all([
    admin.rpc("admin_penge_tal", { p_fra: fra?.toISOString() ?? null, p_til: til.toISOString() }),
    admin.rpc("admin_penge_holdes", { p_graense: HOLDT_GRAENSE }),
    hentStripeBalance(),
    hentStripeBevaegelser(fra, til),
    admin
      .from("drift_tilfaelde")
      .select("noegle", { count: "exact", head: true })
      .is("loest_kl", null)
      .like("noegle", "saldo%"),
    admin.from("betaling_overvaagning").select("sidst_startet_kl").eq("id", true).maybeSingle<{ sidst_startet_kl: string | null }>(),
  ]);
  const saldo: Resultat<SaldoAfstemning> =
    saldoSvar.error || koerselSvar.error
      ? { ok: false, fejl: "Saldo-afstemningen kunne ikke hentes fra databasen." }
      : { ok: true, data: { afvigende: saldoSvar.count ?? 0, sidstKoertKl: koerselSvar.data?.sidst_startet_kl ?? null } };

  if (talSvar.error) console.error("admin_penge_tal:", talSvar.error.message);
  if (holdesSvar.error) console.error("admin_penge_holdes:", holdesSvar.error.message);

  return {
    periode,
    fra: fra?.toISOString() ?? null,
    til: til.toISOString(),
    tal: talSvar.error
      ? { ok: false, fejl: "Pengetallene kunne ikke hentes fra databasen." }
      : { ok: true, data: talSvar.data as PengeTal },
    holdes: holdesSvar.error
      ? { ok: false, fejl: "Beløb hos Stripe kunne ikke hentes fra databasen." }
      : { ok: true, data: holdesSvar.data as PengeHoldes },
    balance,
    bevaegelser,
    saldo,
    testnoegle: erTestnoegle(),
  };
}
