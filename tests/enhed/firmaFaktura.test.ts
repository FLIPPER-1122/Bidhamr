// Faktura fra firma til køber (20261102330000): momsberegning, nummer,
// CSV, ZIP, PDF, mailens afsender - og at der IKKE findes nogen automatisk
// afsendelse i koden. Databasens regler testes i
// tests/penge-db/firmaFakturaer.test.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRUGTMOMS_FAKTURA_TEKST,
  aktuelFaktura,
  beregnFaktura,
  beregnLinje,
  enhedsprisEksklMoms,
  erNyVare,
  type FirmaFakturaRaekke,
  fakturaTalStemmer,
  fakturanummerTekst,
  firmaFakturaCsv,
  nettoAfInkl,
  pdfFilnavn,
  type FirmaFakturaData,
} from "@/lib/erhverv/firmaFaktura";
import { crc32, lavZip } from "@/lib/zip";
import { afsender, fakturaMail } from "@/lib/erhverv/firmaFakturaServer";
import { gyldigLogoUrl, lavFirmaFakturaPdf } from "@/lib/pdf/firmaFakturaPdf";

const ROD = path.resolve(import.meta.dirname, "../..");

function data(over: Partial<FirmaFakturaData> = {}): FirmaFakturaData {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    type: "faktura",
    status: "sendt",
    trade_id: "11111111-2222-4333-8444-666666666666",
    fakturanummer: "BH-0001",
    udstedt_dato: "2026-10-28",
    sendt_kl: "2026-10-28T10:00:00Z",
    krediterer: null,
    saelger: { firmanavn: "Alfa ApS", cvr: "12345678", adresse: "Firmavej 1", postnummer: "4700", by: "Næstved", email: "alfa@firma.dk", telefon: "+4511223344", logo_url: null },
    koeber: { navn: "Kasper Køber", adresse: "Købervej 3", postnummer: "4700", by: "Næstved", email: "kasper@koeber.dk", firmanavn: null, cvr: null },
    linjer: [{ tekst: "Kommode (stand: god)", antal: 1, enhedspris_oere: 12345, beloeb_oere: 12345, netto_oere: 9876, moms_oere: 2469 }],
    momsordning: "moms",
    moms_sats: 25,
    beloeb_ekskl_moms_oere: 9876,
    moms_oere: 2469,
    total_oere: 12345,
    brugtmoms_tekst: null,
    leveringsdato: "2026-10-27",
    betalingstekst: "Betalt via BidHamr",
    mangler: [],
    ...over,
  };
}

describe("moms og brugtmoms", () => {
  it("almindelig moms: netto = 4/5 af beløbet inkl. moms, moms = resten", () => {
    expect(beregnFaktura([10000], "moms")).toEqual({ beloeb_ekskl_moms_oere: 8000, moms_oere: 2000, total_oere: 10000, moms_sats: 25, brugtmoms_tekst: null });
    expect(beregnFaktura([12345], "moms")).toMatchObject({ beloeb_ekskl_moms_oere: 9876, moms_oere: 2469 });
    expect(beregnFaktura([1], "moms")).toMatchObject({ beloeb_ekskl_moms_oere: 1, moms_oere: 0, total_oere: 1 });
    // Pr. linje, summeret.
    expect(beregnFaktura([12345, 3], "moms")).toMatchObject({ beloeb_ekskl_moms_oere: 9876 + 2, moms_oere: 2469 + 1, total_oere: 12348 });
  });

  it("kreditnota (negative beløb) er præcis det modsatte", () => {
    for (const b of [1, 3, 12345, 99999, 2_500_000]) {
      expect(nettoAfInkl(-b)).toBe(0 - nettoAfInkl(b));
      const p = beregnFaktura([b], "moms");
      const m = beregnFaktura([-b], "moms");
      expect(m.moms_oere).toBe(0 - p.moms_oere!);
      expect(m.beloeb_ekskl_moms_oere).toBe(0 - p.beloeb_ekskl_moms_oere!);
    }
  });

  it("brugtmoms: ingen moms vises, men teksten", () => {
    expect(beregnFaktura([50000], "brugtmoms")).toEqual({ beloeb_ekskl_moms_oere: null, moms_oere: null, total_oere: 50000, moms_sats: null, brugtmoms_tekst: "Fortjenstmargenordning – brugte genstande" });
    // Lovens ordlyd - samme tekst som databasen.
    expect(BRUGTMOMS_FAKTURA_TEKST).toBe("Fortjenstmargenordning – brugte genstande");
    const mig = readFileSync(path.join(ROD, "supabase/migrations/20261102390000_firma_fakturaer_rettelser.sql"), "utf8");
    expect(mig).toContain(`'${BRUGTMOMS_FAKTURA_TEKST}'`);
  });

  it("pr. linje: enhedspris og beløb ekskl. moms, momssats og beløb inkl. moms (§ 58, stk. 1)", () => {
    expect(beregnLinje(12345, 1, "moms")).toEqual({ enhedspris_ekskl_moms_oere: 9876, netto_oere: 9876, moms_sats: 25, moms_oere: 2469, beloeb_oere: 12345 });
    expect(beregnLinje(10000, 2, "moms")).toEqual({ enhedspris_ekskl_moms_oere: 4000, netto_oere: 8000, moms_sats: 25, moms_oere: 2000, beloeb_oere: 10000 });
    expect(beregnLinje(-12345, 1, "moms")).toMatchObject({ enhedspris_ekskl_moms_oere: -9876, netto_oere: -9876, moms_oere: -2469 });
    expect(beregnLinje(50000, 1, "brugtmoms")).toEqual({ enhedspris_ekskl_moms_oere: null, netto_oere: null, moms_sats: null, moms_oere: null, beloeb_oere: 50000 });
    // Ældre øjebliksbilleder uden enhedspris ekskl. moms: = netto / antal.
    expect(enhedsprisEksklMoms({ tekst: "x", antal: 1, enhedspris_oere: 12345, beloeb_oere: 12345, netto_oere: 9876, moms_oere: 2469 })).toBe(9876);
    expect(enhedsprisEksklMoms({ tekst: "x", antal: 1, enhedspris_oere: 1, beloeb_oere: 1, netto_oere: null, moms_oere: null })).toBeNull();
    // Kontrollen fanger en forkert linje, selv når totalerne stemmer.
    const d = data();
    expect(fakturaTalStemmer(data({ linjer: [{ ...d.linjer[0], enhedspris_ekskl_moms_oere: 9876, moms_sats: 25 }] }))).toBe(true);
    expect(fakturaTalStemmer(data({ linjer: [{ ...d.linjer[0], enhedspris_ekskl_moms_oere: 9877 }] }))).toBe(false);
    expect(fakturaTalStemmer(data({ linjer: [{ ...d.linjer[0], netto_oere: 9875, moms_oere: 2470 }] }))).toBe(false);
  });

  it("advarsel ved brugtmoms på nye varer", () => {
    expect(erNyVare("ny_med_maerke")).toBe(true);
    expect(erNyVare("Ny")).toBe(true);
    expect(erNyVare("som_ny")).toBe(false);
    expect(erNyVare(null)).toBe(false);
  });

  it("kontrollen fanger tal, der ikke stemmer", () => {
    expect(fakturaTalStemmer(data())).toBe(true);
    expect(fakturaTalStemmer(data({ moms_oere: 2470 }))).toBe(false);
    const brugt = { ...data().linjer[0], netto_oere: null, moms_oere: null };
    expect(fakturaTalStemmer(data({ momsordning: "brugtmoms", linjer: [brugt], moms_oere: null, beloeb_ekskl_moms_oere: null, moms_sats: null }))).toBe(true);
    // Brugtmoms med moms på linjen stemmer ikke.
    expect(fakturaTalStemmer(data({ momsordning: "brugtmoms", moms_oere: null, beloeb_ekskl_moms_oere: null, moms_sats: null }))).toBe(false);
  });
});

describe("nummer, CSV og filnavne", () => {
  it("præfiks + cifre, længere tal afkortes aldrig", () => {
    expect(fakturanummerTekst("BH-", 7, 4)).toBe("BH-0007");
    expect(fakturanummerTekst("", 12345, 4)).toBe("12345");
    expect(fakturanummerTekst("F/", 1, 1)).toBe("F/1");
  });

  it("CSV: semikolon, decimalkomma, BOM og ingen formler", () => {
    const csv = firmaFakturaCsv([data({ koeber: { ...data().koeber, navn: "=HYPERLINK(1)" } })]);
    expect(csv.startsWith("﻿Nummer;Type;Udstedt")).toBe(true);
    expect(csv).toContain("BH-0001;Faktura;2026-10-28");
    expect(csv).toContain("98,76;24,69;123,45");
    expect(csv).toContain("'=HYPERLINK(1)");
  });

  it("filnavne er sikre", () => {
    expect(pdfFilnavn(data({ fakturanummer: "BH/0001" }))).toBe("Faktura-BH_0001.pdf");
    expect(pdfFilnavn(data({ type: "kreditnota", fakturanummer: null }))).toBe("Kreditnota-kladde-11111111.pdf");
  });
});

describe("logo og den aktuelle faktura", () => {
  const BASE = "https://abc.supabase.co";
  const OK = `${BASE}/storage/v1/object/public/avatarer/u1/logo.png`;

  it("logoet skal ligge i avatar-bucketten - ingen .., %2e eller andre værter", () => {
    expect(gyldigLogoUrl(OK, BASE)).toBe(OK);
    for (const ond of [
      `${BASE}/storage/v1/object/public/avatarer/../private/x.png`,
      `${BASE}/storage/v1/object/public/avatarer/%2e%2e/private/x.png`,
      `${BASE}/storage/v1/object/public/avatarer/%2E%2E%2Fprivate/x.png`,
      `${BASE}/storage/v1/object/public/avatarer/u1%2flogo.png`,
      `${BASE}/storage/v1/object/public/avatarer/u1\\logo.png`,
      `${BASE}/storage/v1/object/public/avatarer/`,
      `${BASE}/storage/v1/object/public/andet/x.png`,
      `${BASE}.ond.dk/storage/v1/object/public/avatarer/x.png`,
      `https://ond.dk/storage/v1/object/public/avatarer/x.png`,
      `https://bruger@abc.supabase.co/storage/v1/object/public/avatarer/x.png`,
      `${OK}?x=1`,
      `http://abc.supabase.co/storage/v1/object/public/avatarer/x.png`,
      "ikke en url",
    ]) {
      expect(gyldigLogoUrl(ond, BASE), ond).toBeNull();
    }
  });

  it("efter kreditnota er den aktuelle faktura den ikke-krediterede", () => {
    const r = (o: Partial<FirmaFakturaRaekke>) => ({ trade_id: "t", type: "faktura", krediteret_kl: null, oprettet_kl: "2026-10-01", ...o }) as FirmaFakturaRaekke;
    const gl = r({ id: "gl", krediteret_kl: "2026-10-02", oprettet_kl: "2026-10-01" });
    const ny = r({ id: "ny", oprettet_kl: "2026-10-03" });
    const kredit = r({ id: "k", type: "kreditnota" });
    expect(aktuelFaktura([ny, kredit, gl], "t")?.id).toBe("ny");
    expect(aktuelFaktura([kredit, gl], "t")?.id).toBe("gl");
    expect(aktuelFaktura([gl], "x")).toBeUndefined();
  });
});

describe("ZIP", () => {
  it("CRC32 og en gyldig ZIP-struktur", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const zip = lavZip([
      { navn: "a.pdf", data: new Uint8Array([1, 2, 3]) },
      { navn: "a.pdf", data: new Uint8Array([4]) },
      { navn: "../ond.pdf", data: new Uint8Array([5]) },
    ]);
    const v = new DataView(zip.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    const slut = zip.length - 22;
    expect(v.getUint32(slut, true)).toBe(0x06054b50);
    expect(v.getUint16(slut + 10, true)).toBe(3);
    const tekst = new TextDecoder().decode(zip);
    expect(tekst).toContain("a-2.pdf");
    expect(tekst).not.toContain("../");
  });
});

describe("PDF og mail", () => {
  it("PDF'en laves for faktura, kreditnota og brugtmoms", async () => {
    for (const d of [
      data(),
      data({ status: "kladde", fakturanummer: null, udstedt_dato: null }),
      data({ momsordning: "brugtmoms", moms_oere: null, beloeb_ekskl_moms_oere: null, moms_sats: null, brugtmoms_tekst: BRUGTMOMS_FAKTURA_TEKST }),
      data({ type: "kreditnota", fakturanummer: "BH-0002", krediterer: { id: "x", fakturanummer: "BH-0001", udstedt_dato: "2026-10-28" }, total_oere: -12345 }),
    ]) {
      const pdf = await lavFirmaFakturaPdf(d, null);
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(1000);
    }
  });

  it("afsender er \"Firmanavn via BidHamr\" uden tegn, der kan bryde headeren", () => {
    expect(afsender("Alfa ApS")).toBe('"Alfa ApS via BidHamr" <noreply@bidhamr.dk>');
    expect(afsender('Ond" <x@y.dk>\r\nBcc: z@z.dk')).toBe('"Ond x y.dk Bcc z z.dk via BidHamr" <noreply@bidhamr.dk>');
  });

  it("mailen er kort, dansk og escaper brugerindhold", () => {
    const m = fakturaMail(data({ koeber: { ...data().koeber, navn: "<b>Kasper</b>" } }));
    expect(m.subject).toBe("Faktura nr. BH-0001 fra Alfa ApS");
    expect(m.html).not.toContain("<b>Kasper</b>");
    expect(m.text).toContain("vedhæftet som PDF");
    expect(m.text).not.toMatch(/forsikring/i);
  });
});

// ---------------------------------------------------------------------------
// INGEN automatisk afsendelse (Filip, 27. okt. 2026)
// ---------------------------------------------------------------------------
function filer(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? filer(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
// Kode uden kommentarer (kommentarer må gerne nævne funktionerne).
function udenKommentarer(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}
const SRC = filer(path.join(ROD, "src")).map((p) => ({
  p: path.relative(ROD, p).replace(/\\/g, "/"),
  t: udenKommentarer(readFileSync(p, "utf8")),
}));

describe("ingen automatisk afsendelse", () => {
  it("kun server action'en sendFirmaFaktura kalder firma_faktura_send", () => {
    const brug = SRC.filter((f) => /\brpc\(\s*["'`]firma_faktura_send["'`]/.test(f.t)).map((f) => f.p);
    expect(brug).toEqual(["src/app/actions/firmaFaktura.ts"]);
  });

  it("sendFirmaFaktura bruges kun af Send-knappen (efter bekræftelse)", () => {
    const brug = SRC.filter((f) => /\bsendFirmaFaktura\b/.test(f.t) && f.p !== "src/app/actions/firmaFaktura.ts").map((f) => f.p);
    expect(brug).toEqual(["src/components/firma/FirmaFakturaKnapper.tsx"]);
    const knap = SRC.find((f) => f.p === "src/components/firma/FirmaFakturaKnapper.tsx")!.t;
    // Kaldet sker kun i "Ja, send"-handlingen, ikke i en effect.
    expect(knap).not.toMatch(/useEffect\([^)]*sendFirmaFaktura/);
    expect(knap).toContain("sendBekraeft(");
  });

  it("mailen med fakturaen sendes kun fra server action'erne", () => {
    const brug = SRC.filter((f) => /\bsendFakturaMail\b/.test(f.t)).map((f) => f.p).sort();
    expect(brug).toEqual(["src/app/actions/firmaFaktura.ts", "src/lib/erhverv/firmaFakturaServer.ts"]);
  });

  it("cron, webhooks og app-endpoints rører ikke afsendelsen", () => {
    const auto = SRC.filter((f) => /^src\/app\/api\/(cron|webhooks|app)\//.test(f.p) || /cron/i.test(f.p));
    for (const f of auto) {
      expect(f.t, f.p).not.toMatch(/firma_faktura_send|sendFirmaFaktura|sendFakturaMail|firma_faktura_mail_resultat/);
    }
    const appRute = SRC.filter((f) => f.p.startsWith("src/app/api/firma-faktura/"));
    expect(appRute.length).toBe(2);
    for (const f of appRute) expect(f.t, f.p).not.toMatch(/firma_faktura_send|sendFakturaMail/);
  });

  it("databasen: kun firma_faktura_send sætter status 'sendt', og den kræver auth.uid()", () => {
    for (const navn of ["20261102330000_firma_fakturaer.sql", "20261102390000_firma_fakturaer_rettelser.sql"]) {
      const mig = readFileSync(path.join(ROD, "supabase/migrations", navn), "utf8");
      const saetter = mig.match(/set\s+status\s*=\s*'sendt'/gi) ?? [];
      expect(saetter.length, navn).toBe(1);
      const fn = mig.slice(mig.indexOf("create or replace function public.firma_faktura_send("));
      const krop = fn.slice(0, fn.indexOf("$fn$;", fn.indexOf("$fn$") + 4));
      expect(krop, navn).toMatch(/if v_uid is null or v_firma is null then\s+raise exception/);
      // Den eneste 'set status = sendt' ligger i firma_faktura_send.
      expect(krop, navn).toMatch(/set\s+status\s*=\s*'sendt'/i);
      expect(mig, navn).not.toMatch(/grant execute on function public\.firma_faktura_send\([^)]*\) to [^;]*service_role/);
    }
    const ret = readFileSync(path.join(ROD, "supabase/migrations/20261102390000_firma_fakturaer_rettelser.sql"), "utf8");
    // Manglerne tjekkes igen efter låsen (for update) og ruller tilbage.
    const send = ret.slice(ret.indexOf("create or replace function public.firma_faktura_send("));
    const efterLaas = send.slice(send.indexOf("for update;", send.indexOf("firma_faktura_indstillinger s")));
    expect(efterLaas.slice(0, efterLaas.indexOf("set status = 'sendt'"))).toMatch(/jsonb_array_length\(v_data -> 'mangler'\) > 0 then[\s\S]*?raise exception[\s\S]*?BHF12/);
    // "Lav ny faktura" og momsskift laver kun kladder.
    for (const fnNavn of ["firma_faktura_ny(", "firma_faktura_kladde_momsordning(", "firma_faktura_opret_kladder("]) {
      const f = ret.slice(ret.indexOf(`create or replace function public.${fnNavn}`));
      const krop = f.slice(0, f.indexOf("$fn$;", f.indexOf("$fn$") + 4));
      expect(krop, fnNavn).not.toMatch(/'sendt'\s*,|status\s*=\s*'sendt'/);
    }
    // Ingen planlagt kørsel.
    const alle = readdirSync(path.join(ROD, "supabase/migrations")).map((n) => readFileSync(path.join(ROD, "supabase/migrations", n), "utf8"));
    for (const t of alle) expect(t).not.toMatch(/cron\.schedule[^;]*firma_faktura/i);
  });

  it("Lav ny faktura og momsskift kaldes kun fra knapperne, aldrig automatisk", () => {
    for (const navn of ["lavNyFirmaFaktura", "skiftFirmaFakturaMomsordning"]) {
      const brug = SRC.filter((f) => new RegExp(`\\b${navn}\\b`).test(f.t) && f.p !== "src/app/actions/firmaFaktura.ts").map((f) => f.p);
      expect(brug.length, navn).toBe(1);
      expect(brug[0], navn).toMatch(/^src\/components\/firma\//);
    }
    const auto = SRC.filter((f) => /^src\/app\/api\/(cron|webhooks|app)\//.test(f.p) || /cron/i.test(f.p));
    for (const f of auto) expect(f.t, f.p).not.toMatch(/firma_faktura_ny|firma_faktura_kladde_momsordning/);
  });
});
