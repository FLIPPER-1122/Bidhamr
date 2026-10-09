import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";

// Stripes API-version er låst til den, koden er skrevet og testet til
// (stripe-node 22.2.2's standard). Opgraderes pakken, skal versionen skiftes
// bevidst - og koden testes mod den nye version først (Niels M04).
export const STRIPE_API_VERSION = "2026-05-27.dahlia" as const;

// Hvilken tilstand nøglen er i. rk_ = begrænset nøgle.
export type StripeTilstand = "test" | "live";
export function noeglensTilstand(noegle = process.env.STRIPE_SECRET_KEY ?? ""): StripeTilstand | null {
  if (/^(sk|rk)_live_/.test(noegle)) return "live";
  if (/^(sk|rk)_test_/.test(noegle)) return "test";
  return null;
}

// --- Vagt: nøgle og database skal være i samme Stripe-tilstand (Niels F07) --
//
// Stripe-id'er (kunder, kort, Connect-konti, PaymentIntents ...) findes kun i
// den tilstand, de er oprettet i. public.stripe_tilstand siger, hvilken
// tilstand databasens id'er stammer fra ('test' indtil go-live, se
// docs/GO-LIVE-STRIPE.md). Passer nøglen ikke, nægter serveren at kalde
// Stripe (ALLE kald går gennem vagten i http-klienten herunder) og giver
// drift-alarm. Med live-nøgle afvises også, hvis tilstanden ikke kan læses
// (fail closed); med test-nøgle tillades det (kun testpenge).

export class StripeTilstandFejl extends Error {}

// Et gyldigt svar ('test'/'live') huskes i 60 sekunder. Kunne tilstanden ikke
// læses (databasefejl, ingen række), huskes det kun i 5 sekunder, så en kort
// databasefejl ikke stopper (live) eller tillader (test) Stripe-kald i et
// helt minut.
const CACHE_MS = 60_000;
const CACHE_FEJL_MS = 5_000;
const ALARM_MS = 60_000;
let cache: { tilstand: StripeTilstand | null; kl: number } | null = null;
let sidsteAlarm = 0;

export async function databasensStripeTilstand(): Promise<StripeTilstand | null> {
  if (cache && Date.now() - cache.kl < (cache.tilstand ? CACHE_MS : CACHE_FEJL_MS)) return cache.tilstand;
  let tilstand: StripeTilstand | null = null;
  try {
    const { data, error } = await createAdminClient()
      .from("stripe_tilstand")
      .select("tilstand")
      .eq("id", true)
      .maybeSingle<{ tilstand: string }>();
    if (!error && (data?.tilstand === "test" || data?.tilstand === "live")) tilstand = data.tilstand;
  } catch {
    tilstand = null;
  }
  cache = { tilstand, kl: Date.now() };
  return tilstand;
}

async function alarm(tekst: string) {
  if (Date.now() - sidsteAlarm < ALARM_MS) return;
  sidsteAlarm = Date.now();
  await logDriftFejl({ kilde: "server", hvor: "stripe/tilstand", fejl: tekst });
}

// Kaster StripeTilstandFejl, hvis nøglen og databasen ikke er i samme tilstand.
// Den offentlige nøgle (betalingsformularen i browseren) skal være i samme
// tilstand som den hemmelige - ellers kan køberne ikke betale de
// PaymentIntents, serveren laver (trin 5, F07). null = ikke sat (fx scripts).
export function offentligNoeglesTilstand(
  noegle = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "",
): StripeTilstand | null {
  if (/^pk_live_/.test(noegle)) return "live";
  if (/^pk_test_/.test(noegle)) return "test";
  return null;
}

export async function kraevSammeStripeTilstand(): Promise<StripeTilstand> {
  const noegle = noeglensTilstand();
  if (!noegle) throw new StripeTilstandFejl("STRIPE_SECRET_KEY er hverken en test- eller live-nøgle.");
  const offentlig = offentligNoeglesTilstand();
  if (offentlig && offentlig !== noegle) {
    const tekst = `Stripe-nøglerne passer ikke sammen: STRIPE_SECRET_KEY er ${noegle.toUpperCase()}, men NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY er ${offentlig.toUpperCase()} - alle Stripe-kald er stoppet. Se docs/GO-LIVE-STRIPE.md.`;
    await alarm(tekst);
    throw new StripeTilstandFejl(tekst);
  }
  const db = await databasensStripeTilstand();
  if (db === noegle) return noegle;
  if (db === null && noegle === "test") return noegle;
  const tekst =
    db === null
      ? "Stripe kører med LIVE-nøgle, men databasens Stripe-tilstand (stripe_tilstand) kan ikke læses - alle Stripe-kald er stoppet."
      : `Stripe-nøglen er ${noegle.toUpperCase()}, men databasens Stripe-id'er er fra ${db.toUpperCase()} (stripe_tilstand) - alle Stripe-kald er stoppet. Se docs/GO-LIVE-STRIPE.md.`;
  await alarm(tekst);
  throw new StripeTilstandFejl(tekst);
}

// Kun til test: nulstil cachen.
export function glemStripeTilstand() {
  cache = null;
}

type HttpKlient = ReturnType<typeof Stripe.createNodeHttpClient>;

// Stripes egen Node-klient med vagten foran hvert kald (ekstra sikring - en
// fejl her pakkes af stripe-node ind som StripeConnectionError).
class VagtHttpKlient {
  constructor(private readonly basis: HttpKlient) {}
  getClientName() {
    return this.basis.getClientName();
  }
  async makeRequest(...args: Parameters<HttpKlient["makeRequest"]>) {
    await kraevSammeStripeTilstand();
    return this.basis.makeRequest(...args);
  }
}

// --- medVagt: vagten FØR hvert API-kald -------------------------------------
//
// getStripe() giver Stripe-klienten pakket i en Proxy: hver metode på en
// ressource (stripe.paymentIntents.create, stripe.checkout.sessions.list ...)
// venter først på kraevSammeStripeTilstand() og kalder derefter den rigtige
// metode. Lister virker stadig med `for await` og autoPagingEach/-ToArray.
// Synkrone hjælpere (webhooks.constructEvent, oauth.authorizeUrl) røres ikke.

const StripeRessource = (Stripe as unknown as { StripeResource: abstract new (...a: never[]) => object }).StripeResource;
const IKKE_PAKKET = new Set(["webhooks", "errors", "authorizeUrl", "createFullPath", "createResourcePathWithSymbols"]);
const pakket = new WeakMap<object, object>();

type Liste = {
  autoPagingEach: (...a: unknown[]) => Promise<unknown>;
  autoPagingToArray: (...a: unknown[]) => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function vagtKald(fn: (...a: unknown[]) => unknown, self: object, args: unknown[]): unknown {
  // { r } så det oprindelige (liste-)løfte ikke opløses af .then.
  const klar = kraevSammeStripeTilstand().then(() => ({ r: fn.apply(self, args) }));
  const svar = klar.then(({ r }) => r) as Promise<unknown> & Partial<Liste>;
  // Bruges kun `for await`, må en afvisning ikke blive "unhandled".
  svar.catch(() => {});
  // Også her i { l }: en async-funktion ville ellers opløse listens løfte
  // til første side og miste iteratoren.
  const liste = async () => ({ l: (await klar).r as Liste });
  svar.autoPagingEach = (...a) => liste().then(({ l }) => l.autoPagingEach(...a));
  svar.autoPagingToArray = (...a) => liste().then(({ l }) => l.autoPagingToArray(...a));
  svar[Symbol.asyncIterator] = () => {
    let it: AsyncIterator<unknown> | null = null;
    return {
      next: async () => {
        if (!it) it = (await liste()).l[Symbol.asyncIterator]();
        return it.next();
      },
      return: async () => ({ done: true, value: undefined }),
    };
  };
  return svar;
}

function erRessource(v: unknown, dybde = 0): v is object {
  if (!v || typeof v !== "object") return false;
  if (v instanceof StripeRessource) return true;
  // Navnerum (stripe.checkout, stripe.billingPortal, stripe.v2.core ...).
  return dybde < 3 && Object.values(v).some((x) => erRessource(x, dybde + 1));
}

function medVagt<T extends object>(maal: T): T {
  const kendt = pakket.get(maal);
  if (kendt) return kendt as T;
  const proxy = new Proxy(maal, {
    get(t, noegle, modtager) {
      const v = Reflect.get(t, noegle, modtager);
      if (typeof noegle !== "string" || noegle.startsWith("_") || IKKE_PAKKET.has(noegle)) return v;
      if (typeof v === "function") {
        // Kun metoder på ressourcer - ikke klientens egne hjælpere.
        if (!(t instanceof StripeRessource)) return v;
        return (...args: unknown[]) => vagtKald(v as (...a: unknown[]) => unknown, t, args);
      }
      return erRessource(v) ? medVagt(v) : v;
    },
  });
  pakket.set(maal, proxy);
  return proxy;
}

// Lazy-initialiseret: `new Stripe()` kaster hvis nøglen mangler, og det må
// ikke ske ved module-load (fx under `next build`s page data collection).
let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY mangler i miljøvariablerne.");
    }
    client = medVagt(
      new Stripe(key, {
        apiVersion: STRIPE_API_VERSION,
        httpClient: new VagtHttpKlient(Stripe.createNodeHttpClient()),
      }),
    );
  }
  return client;
}
