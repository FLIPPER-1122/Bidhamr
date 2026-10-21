// Betalingsmetoder (Filip, 20. okt. 2026): kort (inkl. Apple Pay/Google Pay),
// MobilePay og Revolut Pay - ingen Klarna, ingen Link. Rene regler +
// en gennemgang af kildekoden, så intet sted er glemt.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BETALINGSMETODER,
  FORBUDTE_METODER,
  GEM_KORT_METODER,
  METODE_CAPABILITY,
  PAYMENT_ELEMENT_WALLETS,
  erTilladtMetode,
  metodeHandling,
  metodeNoegle,
  metodeTekst,
  platformMetoder,
  platformMetoderFra,
  saelgerMetoder,
  sammeMetoder,
} from "@/lib/betaling/betalingsmetoder";
import { KONTO_CAPABILITIES } from "@/lib/betaling/connect";

const ROD = path.resolve(import.meta.dirname, "../..");

function filer(mappe: string): string[] {
  const ud: string[] = [];
  for (const navn of readdirSync(mappe)) {
    const p = path.join(mappe, navn);
    if (statSync(p).isDirectory()) ud.push(...filer(p));
    else if (/\.(ts|tsx|mts)$/.test(navn)) ud.push(p);
  }
  return ud;
}
const KILDE = filer(path.join(ROD, "src")).map((f) => ({ f: path.relative(ROD, f).replace(/\\/g, "/"), t: readFileSync(f, "utf8") }));

describe("listen", () => {
  it("er præcis kort, MobilePay og Revolut Pay; gem kort kun kort", () => {
    expect([...BETALINGSMETODER]).toEqual(["card", "mobilepay", "revolut_pay"]);
    expect([...GEM_KORT_METODER]).toEqual(["card"]);
    expect(platformMetoder()).toEqual(["card", "mobilepay", "revolut_pay"]);
    for (const f of FORBUDTE_METODER) {
      expect(erTilladtMetode(f)).toBe(false);
      expect(BETALINGSMETODER as readonly string[]).not.toContain(f);
    }
    expect(erTilladtMetode("card")).toBe(true);
    expect(erTilladtMetode(null)).toBe(false);
  });

  it("platformMetoder giver en kopi (listen kan ikke ændres udefra)", () => {
    const a = platformMetoder();
    a.push("klarna" as never);
    expect(platformMetoder()).toEqual(["card", "mobilepay", "revolut_pay"]);
  });

  it("sælgerkontoen anmoder om capability for hver metode", () => {
    for (const m of BETALINGSMETODER) expect(KONTO_CAPABILITIES as readonly string[]).toContain(METODE_CAPABILITY[m]);
  });

  it("saelgerMetoder: kort altid; MobilePay/Revolut Pay kun med aktiv capability", () => {
    expect(saelgerMetoder(undefined)).toEqual(["card"]);
    expect(saelgerMetoder({ card_payments: "active", mobilepay_payments: "pending", revolut_pay_payments: "inactive" })).toEqual(["card"]);
    expect(saelgerMetoder({ card_payments: "active", mobilepay_payments: "active" })).toEqual(["card", "mobilepay"]);
    expect(
      saelgerMetoder({ card_payments: "active", mobilepay_payments: "active", revolut_pay_payments: "active", klarna_payments: "active", link_payments: "active" }),
    ).toEqual(["card", "mobilepay", "revolut_pay"]);
  });

  it("platformMetoderFra: kort altid; MobilePay/Revolut Pay kun når de er available; aldrig andet", () => {
    expect(platformMetoderFra(undefined)).toEqual(["card"]);
    expect(platformMetoderFra({ card: { available: false }, mobilepay: { available: true } })).toEqual(["card", "mobilepay"]);
    expect(
      platformMetoderFra({ mobilepay: { available: true }, revolut_pay: { available: true }, klarna: { available: true }, link: { available: true } }),
    ).toEqual(["card", "mobilepay", "revolut_pay"]);
    expect(platformMetoderFra({ mobilepay: { available: false }, revolut_pay: null })).toEqual(["card"]);
  });

  it("metodeTekst bygges af de metoder, der tilbydes", () => {
    expect(metodeTekst(["card", "mobilepay", "revolut_pay"])).toBe("kort, MobilePay, Revolut Pay, Apple Pay og Google Pay");
    expect(metodeTekst(["card"])).toBe("kort, Apple Pay og Google Pay");
    expect(metodeTekst(["card", "mobilepay"])).toBe("kort, MobilePay, Apple Pay og Google Pay");
    expect(metodeTekst(null)).toBe("kort, Apple Pay og Google Pay");
  });

  it("metodeNoegle: samme metoder = samme nøgle (uanset rækkefølge), andre = ny", () => {
    expect(metodeNoegle(["card", "mobilepay", "revolut_pay"])).toBe("m-card.mobilepay.revolut_pay");
    expect(metodeNoegle(["revolut_pay", "card", "mobilepay"])).toBe("m-card.mobilepay.revolut_pay");
    expect(metodeNoegle(["card"])).not.toBe(metodeNoegle(["card", "mobilepay"]));
  });

  it("sammeMetoder", () => {
    expect(sammeMetoder(["mobilepay", "card"], ["card", "mobilepay"])).toBe(true);
    expect(sammeMetoder(["card"], ["card", "mobilepay"])).toBe(false);
    expect(sammeMetoder(null, [])).toBe(true);
  });
});

describe("metodeHandling (eksisterende PaymentIntents)", () => {
  const T = ["card", "mobilepay", "revolut_pay"];
  const auto = { enabled: true };
  it("automatic_payment_methods og åben: annuller (kan ikke opdateres)", () => {
    for (const status of ["requires_payment_method", "requires_confirmation", "requires_action"]) {
      expect(metodeHandling({ status, automatic_payment_methods: auto, payment_method_types: ["card", "klarna", "link"] }, T)).toBe("annuller");
    }
  });
  it("ikke åben (betalt, behandles, annulleret): ok - kalderen spejler", () => {
    for (const status of ["succeeded", "processing", "canceled", "requires_capture"]) {
      expect(metodeHandling({ status, automatic_payment_methods: auto, payment_method_types: ["klarna"] }, T)).toBe("ok");
    }
  });
  it("eksplicit, samme liste: ok; anden liste: opdater; requires_action med forbudt metode: annuller", () => {
    expect(metodeHandling({ status: "requires_payment_method", automatic_payment_methods: null, payment_method_types: ["revolut_pay", "card", "mobilepay"] }, T)).toBe("ok");
    expect(metodeHandling({ status: "requires_payment_method", automatic_payment_methods: null, payment_method_types: ["card"] }, T)).toBe("opdater");
    expect(metodeHandling({ status: "requires_confirmation", automatic_payment_methods: { enabled: false }, payment_method_types: ["card", "link"] }, T)).toBe("opdater");
    expect(metodeHandling({ status: "requires_action", automatic_payment_methods: null, payment_method_types: ["card", "link"] }, T)).toBe("annuller");
    // Kun en sælger-capability er ændret: køberen må gøre betalingen færdig.
    expect(metodeHandling({ status: "requires_action", automatic_payment_methods: null, payment_method_types: ["card"] }, T)).toBe("ok");
  });
});

describe("kildekoden bruger den fælles liste overalt", () => {
  it("ingen automatic_payment_methods i koden (kun i forklaringen i betalingsmetoder.ts)", () => {
    for (const { f, t } of KILDE) {
      if (f === "src/lib/betaling/betalingsmetoder.ts") continue;
      const uden = t.replace(/\/\/.*$/gm, "");
      expect(uden.includes("automatic_payment_methods"), f).toBe(false);
    }
  });

  it("hver paymentIntents.create har payment_method_types fra den fælles liste", () => {
    const steder: string[] = [];
    for (const { f, t } of KILDE) {
      for (const m of t.matchAll(/paymentIntents\.create\(/g)) {
        steder.push(f);
        const blok = t.slice(m.index!, m.index! + 1500);
        expect(blok, f).toMatch(/payment_method_types:\s*metoder\b/);
      }
    }
    // Checkout (destination), boost, returfragt (inkl. sagens returfragt) og
    // sælgerens ekstra fragt.
    expect(steder.sort()).toEqual([
      "src/lib/betaling/boost.ts",
      "src/lib/betaling/ekstraFragt.ts",
      "src/lib/betaling/returfragt.ts",
      "src/lib/betaling/stripeBetaling.ts",
    ]);
    const metoder = (f: string) => KILDE.find((k) => k.f === f)!.t;
    // Platformens metoder hentes hos Stripe (kun dem, der er slået til).
    for (const f of ["src/lib/betaling/boost.ts", "src/lib/betaling/returfragt.ts", "src/lib/betaling/ekstraFragt.ts"]) {
      expect(metoder(f)).toMatch(/const metoder = await hentPlatformMetoder\(\)/);
      expect(metoder(f)).not.toMatch(/[^.\w]platformMetoder\(\)/);
    }
    expect(metoder("src/lib/betaling/stripeBetaling.ts")).toMatch(/const metoder = klar\.metoder/);
  });

  it("hver paymentIntents.update med payment_method_types bruger listen", () => {
    for (const { f, t } of KILDE) {
      for (const m of t.matchAll(/payment_method_types:\s*([^,\n]+)/g)) {
        const v = m[1].trim();
        const ok =
          /^metoder\b/.test(v) ||
          v === "platformMetoder()" ||
          v === "[...tjek.metoder]" ||
          v === "[...GEM_KORT_METODER]" ||
          // Firmaernes abonnement i Stripe Checkout (MobilePay understøtter
          // ikke abonnementer) - kun kort.
          (f === "src/lib/erhverv/betaling.ts" && v === '["card"]');
        expect(ok, `${f}: payment_method_types: ${v}`).toBe(true);
      }
    }
  });

  it("ingen 'link' eller 'klarna' som betalingsmetode nogen steder", () => {
    for (const { f, t } of KILDE) {
      expect(/payment_method_types:\s*\[[^\]]*["'](link|klarna)["']/.test(t), f).toBe(false);
    }
  });

  it("SetupIntent (gem kort) bruger kun kort", () => {
    const steder = KILDE.filter(({ t }) => /setupIntents\.create\(/.test(t));
    expect(steder.map((s) => s.f)).toEqual(["src/lib/betaling/betalingHandlinger.ts"]);
    const t = steder[0].t;
    const i = t.indexOf("setupIntents.create(");
    expect(t.slice(i, i + 800)).toMatch(/payment_method_types:\s*\[\.\.\.GEM_KORT_METODER\]/);
  });

  it("hvert Payment Element slår Link fra", () => {
    const steder: string[] = [];
    for (const { f, t } of KILDE) {
      for (const m of t.matchAll(/<PaymentElement\b/g)) {
        steder.push(f);
        expect(t.slice(m.index!, m.index! + 400), f).toMatch(/wallets:\s*PAYMENT_ELEMENT_WALLETS/);
      }
    }
    expect(steder.length).toBeGreaterThanOrEqual(4);
    expect(PAYMENT_ELEMENT_WALLETS.link).toBe("never");
  });

  it("CustomerSessions slår hverken Link eller gem til", () => {
    for (const { f, t } of KILDE) {
      for (const m of t.matchAll(/customerSessions\.create\(/g)) {
        const blok = t.slice(m.index!, m.index! + 700);
        expect(blok, f).not.toMatch(/link/i);
        expect(blok, f).toMatch(/payment_method_save:\s*"disabled"/);
      }
    }
  });
});
