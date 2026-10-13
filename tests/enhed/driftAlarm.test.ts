// Drift-alarmmailen: gruppering, alvor, emne, tekster og sikkerhed.
// npm run test:enhed
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALARM_TYPER, ROEDE_PRAEFIKSER, UKENDT_TYPE, alarmKode, alarmType, idIEksempel } from "@/lib/driftAlarmTyper";
import {
  bygAlarmMail,
  eksempelIder,
  GENSEND_MIN,
  GENSEND_ROED_MIN,
  grupperGamleAlarmer,
  renLinks,
  sorterBlokke,
  statusLinje,
  tidsrum,
  type AlarmBlok,
} from "@/lib/driftAlarmMail";

const NU = new Date("2026-10-13T12:25:00Z"); // 14.25 dansk tid

function ukendtBetaling(i: number) {
  return `betaling/ukendt-betaling: Charge ch_3UQ4Ab${String(i).padStart(2, "0")}XyZq til en sælgerkonto er gennemført hos Stripe, men databasen kender den ikke. Kontrollér betalingen i Stripe.`;
}

const blokUkendt: AlarmBlok = {
  noegle: "webhook|betaling/ukendt-betaling",
  slags: "webhook",
  kilde: "webhook",
  kode: "betaling/ukendt-betaling",
  antal: 12,
  fra: "2026-10-13T12:20:05Z",
  til: "2026-10-13T12:21:40Z",
  eksempler: [1, 2, 3].map((i) => ({ sti: null, besked: ukendtBetaling(i) })),
};
const blokCron: AlarmBlok = {
  noegle: "cron|cron/koersel-fejlede",
  slags: "cron",
  kilde: "cron",
  kode: "cron/koersel-fejlede",
  antal: 1,
  fra: "2026-10-13T12:15:00Z",
  til: "2026-10-13T12:15:00Z",
  eksempler: [{ sti: "betalings-cron", besked: "Udbetaling til sælger: timeout" }],
};
const blokWebhook: AlarmBlok = {
  noegle: "webhook|betaling/webhook-udeblev",
  slags: "webhook",
  kilde: "webhook",
  kode: "betaling/webhook-udeblev",
  antal: 1,
  fra: "2026-10-13T12:10:00Z",
  til: "2026-10-13T12:10:00Z",
  eksempler: [{ sti: null, besked: "betaling/webhook-udeblev: Betaling 7f3c2a10-1111-4222-8333-944455556666 (pi_3UQ5AbCdEf) står som 'succeeded'" }],
};

describe("alarmKode", () => {
  it("bruger hvor-delen og fjerner id'er", () => {
    expect(alarmKode("webhook", ukendtBetaling(1))).toBe("betaling/ukendt-betaling");
    expect(alarmKode("webhook", ukendtBetaling(2))).toBe(alarmKode("webhook", ukendtBetaling(1)));
  });
  it("stopper ved første kolon, så underkategorier samles", () => {
    expect(alarmKode("server", "Fragt: priser: fejl 500")).toBe("Fragt");
  });
  it("beholder korte navne med cifre (DAC7)", () => {
    expect(alarmKode("cron", "DAC7-cron: noget gik galt")).toBe("DAC7-cron");
  });
  it("erstatter id'er i tekster uden hvor", () => {
    const a = alarmKode("server", "Charge ch_3UQ4AbCdEf12 til en sælgerkonto er gennemført");
    const b = alarmKode("server", "Charge ch_9ZZZzzzzzz99 til en sælgerkonto er gennemført");
    expect(a).toBe(b);
    expect(a).toContain("#");
    expect(alarmKode("server", "Udbetaling 123e4567-e89b-12d3-a456-426614174000: x")).toBe("Udbetaling #");
  });
  it("browser-fejl får altid koden klient (teksten bruges aldrig)", () => {
    expect(alarmKode("klient", "TypeError: <script>")).toBe("klient");
  });
  it("tom besked", () => {
    expect(alarmKode("server", "")).toBe("(ingen besked)");
    expect(alarmKode("server", null)).toBe("(ingen besked)");
  });
  it("et link er ikke et hvor-præfiks", () => {
    expect(alarmKode("server", "https://x.dk: noget")).toBe("https://x.dk: noget");
  });
});

describe("alarmType", () => {
  it("kendte koder", () => {
    expect(alarmType("webhook", "betaling/ukendt-betaling").titel).toBe("Betalinger, vi ikke kender");
    expect(alarmType("webhook", "betaling/ukendt-betaling").alvor).toBe("roed");
    expect(alarmType("cron", "cron/holdt-op").alvor).toBe("roed");
    expect(alarmType("klient", "klient").alvor).toBe("gul");
  });
  it("præfiks og kilde som reserve", () => {
    expect(alarmType("server", "betaling/noget-nyt").side.sti).toBe("/admin/betalinger");
    expect(alarmType("server", "Fragt").titel).toBe("Fejl i fragten");
    expect(alarmType("webhook", "payment_intent.succeeded").titel).toBe("Beskeder udefra fejler");
  });
  it("listen over røde koder er låst (ret også drift_alarm_er_roed i migrationen)", () => {
    const roede = Object.entries(ALARM_TYPER)
      .filter(([, t]) => t.alvor === "roed")
      .map(([k]) => k)
      .sort();
    expect(roede).toEqual([
      "Afstemningsruten",
      "Forældet PaymentIntent ikke annulleret",
      "Indsigelsesfrister",
      "Kunne ikke gemme PaymentIntent",
      "Lovede refusioner",
      "Lovet refusion",
      "Refusion af afvigelse",
      "Refusion opgivet",
      "Stripe-tilstand",
      "Tilbageførsel ved tabt indsigelse",
      "betaling/admin-frigivelse",
      "betaling/afstemning",
      "betaling/betalingsmodel",
      "betaling/bidhamr-daekker",
      "betaling/charge-mangler",
      "betaling/destination-charge",
      "betaling/fremmed-udbetaling",
      "betaling/gammel-model",
      "betaling/indsigelse",
      "betaling/indsigelse-efter-refusion",
      "betaling/indsigelse-frist",
      "betaling/negativ-udbetaling",
      "betaling/noedstop",
      "betaling/refusion-afstemning",
      "betaling/saldo",
      "betaling/udbetaling-konflikt",
      "betaling/ukendt-betaling",
      "cron/holdt-op",
      "cron/koersel-fejlede",
      "cron/koersel-haenger",
      "erhverv/admin-pris-tilbage",
      "erhverv/dobbelt-abonnement",
      "erhverv/opgradering-refusion-fejl",
      "erhverv/opgradering-ukendt",
      "erhverv/rul-tilbage",
      "kald_betalings_cron",
      "kald_pengeafstemning",
      "stripe/tilstand",
      "tilstand",
    ]);
    expect(ROEDE_PRAEFIKSER).toEqual(["Pengeafstemning", "betaling/"]);
  });
  it.each(ROEDE_PRAEFIKSER)("en ukendt kode efter det røde præfiks %s er rød", (p) => {
    for (const kilde of ["server", "action", "cron"]) {
      expect(alarmType(kilde, `${p}ukendt-kode-xyz`).alvor).toBe("roed");
    }
  });
  it("webhook er rød uanset præfiks, ukendte betaling/* er røde", () => {
    expect(alarmType("webhook", "Fragt").alvor).toBe("roed");
    expect(alarmType("webhook", "erhverv/fornyelse-med-proration").alvor).toBe("roed");
    expect(alarmType("server", "betaling/noget-nyt").alvor).toBe("roed");
    expect(alarmType("server", "Fragt").alvor).toBe("gul");
    expect(alarmType("cron", "Refusion opgivet").alvor).toBe("roed");
  });
  it("migrationens røde liste er den samme som ALARM_TYPER", () => {
    const sql = readFileSync(
      path.resolve(import.meta.dirname, "../../supabase/migrations/20261021030000_drift_alarm_blokke.sql"),
      "utf8",
    );
    const fn = sql.slice(sql.indexOf("function public.drift_alarm_er_roed"));
    const lister = [...fn.matchAll(/any \(array\[([\s\S]*?)\]\)/g)].map((m) =>
      [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")).sort(),
    );
    const efter = (a: "roed" | "gul") =>
      Object.entries(ALARM_TYPER)
        .filter(([, t]) => t.alvor === a)
        .map(([k]) => k)
        .sort();
    expect(lister[0]).toEqual(efter("roed"));
    expect(lister[1]).toEqual(efter("gul"));
  });
  it("ukendte koder får den neutrale tekst", () => {
    expect(alarmType("server", "Noget helt andet")).toBe(UKENDT_TYPE);
    expect(UKENDT_TYPE.titel).toBe("Teknisk fejl – se drift-siden");
  });
  it("alle tekster er korte, danske og uden 'forsikring'", () => {
    for (const t of Object.values(ALARM_TYPER)) {
      for (const tekst of [t.titel, t.betyder, t.goer, t.emne(2)]) {
        expect(tekst.toLowerCase()).not.toContain("forsikring");
        expect(tekst).not.toMatch(/\s$/);
      }
      expect(t.titel.length).toBeLessThanOrEqual(50);
      expect(t.side.sti).toMatch(/^\/admin(\/|$)/);
    }
  });
});

describe("idIEksempel og eksempler", () => {
  it("finder Stripe-id'er og uuid'er", () => {
    expect(idIEksempel(ukendtBetaling(1))).toBe("ch_3UQ4Ab01XyZq");
    expect(idIEksempel("Handel 7f3c2a10-1111-4222-8333-944455556666 x")).toBe("7f3c2a10-1111-4222-8333-944455556666");
    expect(idIEksempel("ingen id her")).toBeNull();
  });
  it("højst 3 eksempler, ingen dubletter", () => {
    const b = { ...blokUkendt, eksempler: [1, 2, 3, 4, 1].map((i) => ({ besked: ukendtBetaling(i) })) };
    const ider = eksempelIder(b);
    expect(ider).toHaveLength(3);
    expect(new Set(ider).size).toBe(3);
  });
  it("cron-blokke viser jobnavnet", () => {
    expect(eksempelIder(blokCron)).toEqual(["betalings-cron"]);
  });
});

describe("tidsrum", () => {
  it("flere gange i et tidsrum", () => {
    expect(tidsrum(blokUkendt, NU)).toBe("12 gange mellem 14.20 og 14.21");
  });
  it("én gang", () => {
    expect(tidsrum(blokCron, NU)).toBe("1 gang kl. 14.15");
  });
  it("en anden dag får dato med", () => {
    expect(tidsrum({ ...blokCron, fra: "2026-10-12T08:00:00Z", til: "2026-10-12T08:00:00Z" }, NU)).toBe(
      "1 gang 12. okt. kl. 10.00",
    );
  });
  it("betalings-cron i stå", () => {
    const b = { ...blokCron, kode: "cron/holdt-op", fra: "2026-10-13T10:20:00Z", til: "2026-10-13T10:20:00Z" };
    expect(tidsrum(b, NU)).toBe("Sidste vellykkede kørsel kl. 12.20 – for 2 timer siden");
  });
});

describe("sortering og status", () => {
  it("røde før gule, så flest", () => {
    const s = sorterBlokke([blokWebhook, blokCron, blokUkendt]);
    expect(s.map((b) => b.kode)).toEqual(["betaling/ukendt-betaling", "cron/koersel-fejlede", "betaling/webhook-udeblev"]);
  });
  it("statuslinjen", () => {
    expect(statusLinje(1, 2)).toBe("Der er 1 ting, du skal se på nu, og 2 ting, der kun er til orientering.");
    expect(statusLinje(2, 0)).toBe("Der er 2 ting, du skal se på nu.");
    expect(statusLinje(0, 3)).toBe("Der er ikke noget, der haster. 3 ting er til orientering.");
  });
});

describe("bygAlarmMail", () => {
  const mail = bygAlarmMail([blokWebhook, blokCron, blokUkendt], NU);

  it("emnelinjen har det vigtigste og antal", () => {
    expect(mail.subject).toBe("BidHamr: 12 betalinger kræver tjek (og 2 andre ting)");
    expect(bygAlarmMail([{ ...blokUkendt, antal: 2 }], NU).subject).toBe("BidHamr: 2 betalinger kræver tjek");
  });
  it("emne for betalings-cron i stå", () => {
    const b = { ...blokCron, kode: "cron/holdt-op", noegle: "cron|cron/holdt-op", fra: "2026-10-13T10:20:00Z" };
    expect(bygAlarmMail([b], NU).subject).toBe("BidHamr: Betalings-cron har ikke kørt i 2 timer");
  });
  it("status øverst, røde før gule, knap pr. blok og til drift-siden", () => {
    const t = mail.text;
    expect(t).toContain("Der er 2 ting, du skal se på nu, og 1 ting, der kun er til orientering.");
    expect(t.indexOf("SKAL SES PÅ NU")).toBeLessThan(t.indexOf("HOLD ØJE"));
    expect(t.indexOf("Betalinger, vi ikke kender")).toBeLessThan(t.indexOf("Besked fra Stripe kom ikke frem"));
    expect(t).toContain("12 gange mellem 14.20 og 14.21");
    expect(t).toContain("Åbn Penge: https://");
    expect(t).toContain("/admin/penge");
    expect(t).toContain("Åbn drift-siden: https://");
    expect(mail.html).toContain("/admin/drift");
    expect(mail.html).toContain("/admin/betalinger");
  });
  it("ét eksempel-sæt pr. blok med højst 3 id'er", () => {
    const linje = mail.text.split("\n").find((l) => l.startsWith("Eksempler: ch_"));
    expect(linje?.split(",").length).toBe(3);
  });
  it("tekniske koder står kun i den grå linje", () => {
    const linjer = mail.text.split("\n").filter((l) => l.includes("betaling/ukendt-betaling"));
    expect(linjer).toEqual(["Teknisk: webhook · betaling/ukendt-betaling"]);
    expect(mail.text).not.toContain("Kontrollér betalingen i Stripe.");
  });
  it("ingen 'forsikring'", () => {
    expect(mail.html.toLowerCase()).not.toContain("forsikring");
    expect(mail.text.toLowerCase()).not.toContain("forsikring");
  });
  it("browser-fejl viser aldrig tekst", () => {
    const m = bygAlarmMail(
      [
        {
          noegle: "klient|klient",
          slags: "ny_fejl",
          kilde: "klient",
          kode: "klient",
          antal: 3,
          fra: null,
          til: null,
          eksempler: [{ besked: "<img src=x onerror=alert(1)> evil.com" }],
        },
      ],
      NU,
    );
    expect(m.html).not.toContain("evil.com");
    expect(m.html).not.toContain("onerror");
    expect(m.text).toContain("Fejl i brugernes browser");
  });
  it("ukendte fejl: neutral tekst, fejlteksten renset og escapet i grå", () => {
    const m = bygAlarmMail(
      [
        {
          noegle: "server|Noget",
          slags: "ny_fejl",
          kilde: "server",
          kode: "Noget",
          antal: 1,
          fra: "2026-10-13T12:00:00Z",
          til: "2026-10-13T12:00:00Z",
          eksempler: [{ besked: "Noget: gå til https://evil.com/login <b>nu</b>" }],
        },
      ],
      NU,
    );
    expect(m.subject).toBe("BidHamr: 1 teknisk fejl");
    expect(m.html).toContain("Teknisk fejl – se drift-siden");
    expect(m.html).not.toContain("evil.com");
    expect(m.html).not.toContain("<b>nu</b>");
    expect(m.html).toContain("&lt;b&gt;nu&lt;/b&gt;");
  });
  it("forklarer reglen for gentagelser i bunden", () => {
    expect(GENSEND_ROED_MIN).toBe(15);
    expect(GENSEND_MIN).toBe(60);
    expect(mail.text).toContain("Nye fejl sendes med det samme.");
    expect(mail.text).toContain("røde højst hvert 15. minut, gule højst én gang i timen");
  });
  it("sendt igen, fordi antallet er steget", () => {
    const m = bygAlarmMail([{ ...blokUkendt, gentaget: true, forrige_antal: 3 }], NU);
    expect(m.text).toContain("sendt igen, fordi antallet er steget");
  });
});

describe("grupperGamleAlarmer (databasen uden den nye migration)", () => {
  it("samler punkter af samme type i én blok", () => {
    const blokke = grupperGamleAlarmer([
      {
        slags: "webhook",
        antal: 13,
        punkter: [
          ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({
            kilde: "webhook",
            besked: ukendtBetaling(i),
            senest_kl: `2026-10-13T12:2${i % 2}:00Z`,
          })),
          { kilde: "webhook", sti: "stripe-webhook", besked: "payment_intent.succeeded: boom", senest_kl: "2026-10-13T12:22:00Z" },
        ],
      },
      {
        slags: "cron",
        antal: 2,
        punkter: [
          { type: "Cron er holdt op", sti: "betalings-cron", besked: "Ingen vellykket kørsel", startet_kl: "2026-10-13T12:00:00Z" },
          { type: "Cron-fejl", kilde: undefined, sti: "betalings-cron", besked: "Udbetaling til sælger: x", senest_kl: "2026-10-13T12:01:00Z" },
        ],
      },
      { slags: "mange_fejl", antal: 40, punkter: [{ kilde: "klient", antal: 30 }, { kilde: "server", besked: "Fragt: priser: x", antal: 10 }] },
    ]);
    const ukendt = blokke.find((b) => b.kode === "betaling/ukendt-betaling");
    expect(ukendt?.antal).toBe(9);
    expect(ukendt?.eksempler).toHaveLength(3);
    expect(ukendt?.fra).toBe("2026-10-13T12:20:00Z");
    expect(ukendt?.til).toBe("2026-10-13T12:21:00Z");
    expect(blokke.find((b) => b.kode === "payment_intent.succeeded")?.antal).toBe(1);
    expect(blokke.find((b) => b.kode === "cron/holdt-op")).toBeTruthy();
    expect(blokke.find((b) => b.kode === "Udbetaling til sælger")?.kilde).toBe("cron");
    const mange = blokke.find((b) => b.kode === "mange-fejl");
    expect(mange?.antal).toBe(40);
    const m = bygAlarmMail(blokke, NU);
    expect(m.text).toContain("Hyppigst: Fejl i brugernes browser (30), Fejl i fragten (10).");
  });
  it("én gruppe får hele antallet", () => {
    const [b] = grupperGamleAlarmer([
      { slags: "webhook", antal: 25, punkter: [1, 2].map((i) => ({ kilde: "webhook", besked: ukendtBetaling(i) })) },
    ]);
    expect(b.antal).toBe(25);
  });
});

describe("renLinks", () => {
  it("fremmede domæner fjernes, egne gøres ikke-klikbare", () => {
    expect(renLinks("se https://evil.com/x").tekst).toBe("se [link fjernet]");
    expect(renLinks("se https://bidhamr.dk/admin").tekst).toBe("se hxxps://bidhamr.dk/admin");
    expect(renLinks("se evil.com/login").tekst).toBe("se [domæne fjernet]");
  });
  it("alle topdomæner, men ikke filnavne og Stripe-hændelser", () => {
    expect(renLinks("se evil.museum og x.travel/a").tekst).toBe("se [domæne fjernet] og [domæne fjernet]");
    expect(renLinks("fejl i drift.ts og charge.dispute.created").tekst).toBe("fejl i drift.ts og charge.dispute.created");
    expect(renLinks("payment_intent.succeeded").renset).toBe(false);
  });
  it("query fjernes også fra egne domæner uden skema", () => {
    expect(renLinks("bidhamr.dk/nulstil?token=abc").tekst).toBe("bidhamr.dk/nulstil");
    expect(renLinks("https://bidhamr.dk/x?token=abc").tekst).toBe("hxxps://bidhamr.dk/x");
    expect(renLinks("evil.com?x=1").tekst).toBe("[domæne fjernet]");
  });
});
