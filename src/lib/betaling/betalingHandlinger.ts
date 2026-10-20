import "server-only";

// Betalingens handlinger - ÉN kodevej for hjemmesidens server actions
// (src/app/actions/betaling.ts) og appens endpoint
// (POST /api/betaling/app/<handling>, docs/APP-BETALING.md).
//
// brugerId SKAL komme fra et verificeret login (cookie-session eller
// Bearer-token valideret med auth.getUser). Beløb kommer aldrig fra klienten -
// kun fra betalingsrækken i databasen. Ingen ny pengelogik her: alt går
// gennem sikrPaymentIntent m.fl. i stripeBetaling.ts.
//
// Fejl RETURNERES som { fejl, kode } - fejl er en dansk tekst, der kan vises.

import { getStripe } from "@/lib/stripe";
import { logDriftFejl } from "@/lib/drift";
import { NYE_BETALINGER_STOPPET_TEKST } from "@/lib/betaling/noedstop";
import { erTilladtMetode, GEM_KORT_METODER, sammeMetoder } from "@/lib/betaling/betalingsmetoder";
import {
  BetalingsFejl,
  LeveringManglerFejl,
  BetalingVenterFejl,
  VENTER_TEKST,
  hentBetalingForHandel,
  hentProfil,
  kundeSessionTilCheckout,
  onboardingLink,
  registrerGemtKort,
  sikrPaymentIntent,
  sikrStripeKunde,
  spejlConnectKonto,
  spejlPaymentIntent,
  stripeOversigtLink,
  type BetalingsKanal,
  type OnboardingRetur,
} from "@/lib/betaling/stripeBetaling";

export const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// kode til appen (og hjemmesiden, hvor den bruges):
//   betalt          - allerede betalt eller under behandling (hent handlen igen)
//   vaelg_levering  - køberen skal vælge levering først
//   venter          - betalingen venter på sælgerens Stripe-konto
//   pause           - nødstop: nye betalinger er midlertidigt sat på pause
//   afvist          - kan ikke betales (fx frist overskredet, annulleret)
//   ikke_fundet     - handlen findes ikke (eller er ikke din)
//   fejl            - uventet fejl (logget i /admin/drift)
export type BetalingsFejlKode = "betalt" | "vaelg_levering" | "venter" | "pause" | "afvist" | "ikke_fundet" | "fejl";
export type HandlingsFejl = { fejl: string; kode: BetalingsFejlKode };

// ------------------------------------------------------------------ betal

export type BetalingStartet = {
  ok: true;
  clientSecret: string;
  totalOere: number;
  // Stripe-kunden på PaymentIntenten (PaymentSheet: customerId).
  customerId: string | null;
  // Kun når køberen har et gemt kort - forudfylder kun. null = intet kort.
  customerSessionClientSecret: string | null;
  // PaymentIntentens metoder (betalingsmetoder.ts) - fx til teksten "Du kan
  // betale med ...". MobilePay/Revolut Pay kun, hvis sælgerens konto har dem.
  betalingsmetoder: string[];
};

// Starter (eller genoptager) betalingen for en vundet auktion. Samme
// PaymentIntent genbruges (idempotency key pr. betaling og forsøg i
// sikrPaymentIntent). Ingen automatisk betaling: kortet trækkes først, når
// køberen selv trykker Betal.
export async function startBetalingFor(
  brugerId: string,
  handelId: unknown,
  kanal: BetalingsKanal = "web",
): Promise<BetalingStartet | HandlingsFejl> {
  if (typeof handelId !== "string" || !UUID.test(handelId)) {
    return { fejl: "Betalingen findes ikke.", kode: "ikke_fundet" };
  }
  try {
    const b = await hentBetalingForHandel(handelId);
    if (!b || b.buyer_id !== brugerId) return { fejl: "Betalingen findes ikke.", kode: "ikke_fundet" };
    if (b.status === "betalt") return { fejl: "Handlen er allerede betalt.", kode: "betalt" };
    if (b.status === "behandles") {
      return { fejl: "Din betaling behandles. Du hører fra os, når den er gennemført.", kode: "betalt" };
    }
    if (b.status !== "afventer") return { fejl: "Handlen kan ikke længere betales.", kode: "afvist" };
    if (b.venter_paa_saelgerkonto_kl) return { fejl: VENTER_TEKST, kode: "venter" };
    if (new Date(b.betal_senest).getTime() < Date.now()) {
      return { fejl: "Fristen for at betale er overskredet.", kode: "afvist" };
    }

    const pi = await sikrPaymentIntent(b);
    if (pi.status === "succeeded" || pi.status === "processing") {
      await spejlPaymentIntent(pi);
      return { fejl: "Handlen er allerede betalt.", kode: "betalt" };
    }
    if (pi.status === "canceled") return { fejl: "Handlen kan ikke længere betales.", kode: "afvist" };
    if (pi.amount !== Number(b.total_oere)) return { fejl: GENERISK, kode: "fejl" };
    if (!pi.client_secret) return { fejl: GENERISK, kode: "fejl" };

    return {
      ok: true,
      clientSecret: pi.client_secret,
      totalOere: pi.amount,
      customerId: typeof pi.customer === "string" ? pi.customer : (pi.customer?.id ?? null),
      customerSessionClientSecret: await kundeSessionTilCheckout(brugerId, pi, kanal),
      betalingsmetoder: (pi.payment_method_types ?? []).filter((t) => erTilladtMetode(t)),
    };
  } catch (err) {
    if (err instanceof LeveringManglerFejl) return { fejl: err.message, kode: "vaelg_levering" };
    if (err instanceof BetalingVenterFejl) return { fejl: err.message, kode: "venter" };
    if (err instanceof BetalingsFejl) {
      return { fejl: err.message, kode: err.message === NYE_BETALINGER_STOPPET_TEKST ? "pause" : "afvist" };
    }
    console.error("startBetaling fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "startBetaling", fejl: err, brugerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
}

// ------------------------------------------------------------------ gemt kort

export type Betalingsindstillinger = {
  // Gemt kort bruges kun til at forudfylde checkout (ingen automatisk betaling).
  gemtKort: { maerke: string | null; sidste4: string | null; udloeb: string | null } | null;
  saelger: {
    harKonto: boolean;
    detaljerIndsendt: boolean;
    overfoerslerAktiv: boolean;
    udbetalingerAktiv: boolean;
    // Stripe mangler oplysninger efter indsendelse (requirements.currently_due
    // eller past_due) - sælgeren skal fortsætte opsætningen.
    manglerOplysninger: boolean;
    // Stripe har afvist kontoen (disabled_reason rejected.*).
    afvist: boolean;
    // Sælgeren har lukket/frakoblet kontoen hos Stripe.
    frakoblet: boolean;
    // Kontoen blev ikke godkendt i tide, og en auktion er annulleret: kan ikke
    // sætte varer til salg, før Stripe har godkendt kontoen (betalingsmodel
    // destination, 20261011020000).
    frosset: boolean;
    // En udbetaling til banken er fejlet - sælgeren skal rette bankkontoen hos Stripe.
    venterPaaBank: boolean;
  };
};

export async function hentBetalingsindstillingerFor(brugerId: string): Promise<Betalingsindstillinger> {
  const p = await hentProfil(brugerId);
  return {
    gemtKort: p?.gemt_betalingsmetode_id
      ? { maerke: p.gemt_kort_maerke, sidste4: p.gemt_kort_sidste4, udloeb: p.gemt_kort_udloeb }
      : null,
    saelger: {
      harKonto: !!p?.stripe_account_id,
      detaljerIndsendt: !!p?.connect_detaljer_indsendt,
      overfoerslerAktiv: !!p?.connect_overfoersler_aktiv,
      udbetalingerAktiv: !!p?.connect_udbetalinger_aktiv,
      manglerOplysninger:
        !!p?.stripe_account_id &&
        ((p.connect_mangler_nu?.length ?? 0) > 0 || (p.connect_mangler_forfaldne?.length ?? 0) > 0),
      afvist: !!p?.connect_spaerret_aarsag?.startsWith("rejected."),
      frakoblet: !!p?.connect_frakoblet_kl,
      frosset: !!p?.saelger_frosset_kl,
      venterPaaBank: !!p?.connect_udbetaling_fejlet_kl,
    },
  };
}

export type GemKortStartet = {
  ok: true;
  clientSecret: string;
  customerId: string;
  // Kun kanal "app": PaymentSheet i opsætningstilstand kræver en kunde.
  // Sessionen viser ingen gemte kort og kan hverken gemme eller fjerne.
  customerSessionClientSecret: string | null;
};

// Starter "gem kort": en SetupIntent (on_session, kun kort), som klienten
// bekræfter (Payment Element / PaymentSheet). Kortet bruges kun til at
// forudfylde checkout.
export async function startGemKortFor(
  brugerId: string,
  kanal: BetalingsKanal = "web",
): Promise<GemKortStartet | HandlingsFejl> {
  try {
    const kunde = await sikrStripeKunde(brugerId);
    const stripe = getStripe();

    // Genbrug en åben SetupIntent for kunden, så gentagne klik ikke opretter
    // en ny hver gang - men kun en, der er NYERE end det gemte kort og seneste
    // "Fjern kort". En ældre ville registrerGemtKort afvise bagefter (kortet
    // blev ikke gemt), så den annulleres, og der laves en ny.
    const profil = await hentProfil(brugerId);
    const p2 = profil as (typeof profil & { gemt_kort_kl?: string | null; kort_fjernet_kl?: string | null }) | null;
    const graense = Math.max(
      ...[p2?.gemt_kort_kl, p2?.kort_fjernet_kl].map((x) => (x ? Math.floor(new Date(x).getTime() / 1000) : 0)),
    );
    const aabne = await stripe.setupIntents.list({ customer: kunde, limit: 10 });
    let aaben: (typeof aabne.data)[number] | undefined;
    for (const s of aabne.data) {
      if (
        (s.usage !== "on_session" && s.usage !== "off_session") ||
        s.metadata?.bruger_id !== brugerId ||
        !(s.status === "requires_payment_method" || s.status === "requires_confirmation" || s.status === "requires_action")
      ) {
        continue;
      }
      // off_session er fra før automatisk betaling blev fjernet: genbruges
      // aldrig (kortet må kun gemmes til on-session brug) - annulleres.
      // Kun kort (betalingsmetoder.ts, Filip 20. okt. 2026): en åben
      // SetupIntent med andre metoder genbruges aldrig.
      if (s.usage === "off_session" || s.created <= graense || !sammeMetoder(s.payment_method_types, GEM_KORT_METODER)) {
        try {
          await stripe.setupIntents.cancel(s.id);
        } catch (err) {
          console.warn("Kunne ikke annullere gammel SetupIntent:", s.id, err instanceof Error ? err.message : err);
        }
        continue;
      }
      aaben ??= s;
    }

    let clientSecret = aaben?.client_secret ?? null;
    if (!clientSecret) {
      // Idempotency key bygget på kundens seneste SetupIntent: samtidige kald
      // ser samme liste og får samme SetupIntent. Når den er brugt, er den selv
      // den seneste, så næste "skift kort" får en ny nøgle.
      const vindue = aabne.data[0]?.id ?? "foerste";
      const si = await stripe.setupIntents.create(
        {
          customer: kunde,
          // Kortet bruges kun, når køberen selv betaler i checkout (ingen
          // automatisk betaling, Filip 9. okt. 2026).
          usage: "on_session",
          // Kun kort (inkl. Apple Pay / Google Pay, som gemmes som kort).
          // MobilePay og Revolut Pay gemmes ikke (betalingsmetoder.ts).
          payment_method_types: [...GEM_KORT_METODER],
          metadata: { bruger_id: brugerId },
        },
        { idempotencyKey: `bidhamr-gemkort-${brugerId}-${vindue}` },
      );
      clientSecret = si.client_secret;
    }
    if (!clientSecret) return { fejl: GENERISK, kode: "fejl" };

    let session: string | null = null;
    if (kanal === "app") {
      // Ingen penge flyttes - sessionen giver kun PaymentSheet adgang til
      // kunden. Gemte kort vises ikke her (kortet skiftes kun via SetupIntenten).
      const s = await stripe.customerSessions.create({
        customer: kunde,
        components: {
          mobile_payment_element: {
            enabled: true,
            features: {
              payment_method_redisplay: "disabled",
              payment_method_remove: "disabled",
              payment_method_save: "disabled",
            },
          },
        },
      });
      session = s.client_secret;
    }
    return { ok: true, clientSecret, customerId: kunde, customerSessionClientSecret: session };
  } catch (err) {
    console.error("startGemKort fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "startGemKort", fejl: err, brugerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
}

// Efter bekræftelsen af SetupIntenten: kortet registreres med det samme
// (webhooken gør det samme bagefter). Kun brugerens egen SetupIntent.
export async function bekraeftGemtKortFor(
  brugerId: string,
  setupIntentId: unknown,
): Promise<{ ok: true } | HandlingsFejl> {
  if (typeof setupIntentId !== "string" || !/^seti_[A-Za-z0-9]{1,200}$/.test(setupIntentId)) {
    return { fejl: "Ugyldig forespørgsel.", kode: "afvist" };
  }
  try {
    const profil = await hentProfil(brugerId);
    const si = await getStripe().setupIntents.retrieve(setupIntentId);
    const kunde = typeof si.customer === "string" ? si.customer : si.customer?.id;
    if (!profil?.stripe_customer_id || kunde !== profil.stripe_customer_id) {
      return { fejl: "Ugyldig forespørgsel.", kode: "afvist" };
    }
    if (si.status !== "succeeded") return { fejl: "Kortet blev ikke gemt.", kode: "afvist" };
    // Afvist fx ved et forsinket svar efter "Fjern kort", eller kortet er
    // fjernet hos Stripe i mellemtiden.
    if (!(await registrerGemtKort(si))) {
      return { fejl: "Kortet blev ikke gemt. Prøv at tilføje det igen.", kode: "afvist" };
    }
    return { ok: true };
  } catch (err) {
    console.error("bekraeftGemtKort fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "bekraeftGemtKort", fejl: err, brugerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
}

// ------------------------------------------------------------------ sælger

// Opretter (én gang) sælgerens Connect Express-konto og returnerer et
// onboarding-link. Linket må kun gives til den indloggede bruger (ikke mailes).
export async function startOnboardingFor(
  brugerId: string,
  retur: OnboardingRetur,
  kanal: BetalingsKanal = "web",
): Promise<{ ok: true; url: string } | HandlingsFejl> {
  try {
    return { ok: true, url: await onboardingLink(brugerId, retur, kanal) };
  } catch (err) {
    if (err instanceof BetalingsFejl) return { fejl: err.message, kode: "afvist" };
    console.error("startSaelgerOnboarding fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "startSaelgerOnboarding", fejl: err, brugerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
}

// Henter sælgerkontoens status direkte fra Stripe (fx efter onboarding).
export async function opdaterSaelgerStatusFor(brugerId: string): Promise<{ ok: true } | HandlingsFejl> {
  try {
    const p = await hentProfil(brugerId);
    if (!p?.stripe_account_id) return { ok: true };
    const konto = await getStripe().accounts.retrieve(p.stripe_account_id);
    await spejlConnectKonto(konto);
    return { ok: true };
  } catch (err) {
    console.error("opdaterSaelgerStatus fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "opdaterSaelgerStatus", fejl: err, brugerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
}

// Engangs-link til sælgerens egen oversigt hos Stripe (Express Dashboard).
export async function stripeOversigtFor(brugerId: string): Promise<{ ok: true; url: string } | HandlingsFejl> {
  try {
    const url = await stripeOversigtLink(brugerId);
    if (!url) return { fejl: "Du skal først gøre opsætningen af din udbetalingskonto færdig.", kode: "afvist" };
    return { ok: true, url };
  } catch (err) {
    console.error("aabnStripeOversigt fejlede:", err);
    return { fejl: GENERISK, kode: "fejl" };
  }
}
