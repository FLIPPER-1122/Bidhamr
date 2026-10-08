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

const CACHE_MS = 60_000;
let cache: { tilstand: StripeTilstand | null; kl: number } | null = null;
let sidsteAlarm = 0;

export async function databasensStripeTilstand(): Promise<StripeTilstand | null> {
  if (cache && Date.now() - cache.kl < CACHE_MS) return cache.tilstand;
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
  if (Date.now() - sidsteAlarm < CACHE_MS) return;
  sidsteAlarm = Date.now();
  await logDriftFejl({ kilde: "server", hvor: "stripe/tilstand", fejl: tekst });
}

// Kaster StripeTilstandFejl, hvis nøglen og databasen ikke er i samme tilstand.
export async function kraevSammeStripeTilstand(): Promise<StripeTilstand> {
  const noegle = noeglensTilstand();
  if (!noegle) throw new StripeTilstandFejl("STRIPE_SECRET_KEY er hverken en test- eller live-nøgle.");
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

// Stripes egen Node-klient med vagten foran hvert kald.
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

// Lazy-initialiseret: `new Stripe()` kaster hvis nøglen mangler, og det må
// ikke ske ved module-load (fx under `next build`s page data collection).
let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY mangler i miljøvariablerne.");
    }
    client = new Stripe(key, {
      apiVersion: STRIPE_API_VERSION,
      httpClient: new VagtHttpKlient(Stripe.createNodeHttpClient()),
    });
  }
  return client;
}
