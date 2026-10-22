import { describe, expect, it, vi } from "vitest";
import { crc32, lavZip, sikkertZipNavn } from "@/lib/reklamation/zip";
import { betingelseTekst, fortolkKroner, kanKvittere, kronerTilOere, reklamationStatusSaelger, reklamationTrin } from "@/lib/reklamation/typer";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/notifikationer/send", () => ({ send: vi.fn() }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}), StripeTilstandFejl: class extends Error {} }));

describe("ZIP", () => {
  it("crc32 matcher kendt værdi", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("laver en gyldig stored ZIP med unikke, sikre navne", () => {
    const a = new TextEncoder().encode("hej æøå");
    const b = new Uint8Array([1, 2, 3, 4]);
    const zip = lavZip([
      { navn: "../a.txt", data: a },
      { navn: "a.txt", data: b },
    ]);
    const dv = new DataView(zip.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    // End of central directory til sidst.
    const eocd = zip.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
    const cenStart = dv.getUint32(eocd + 16, true);
    expect(dv.getUint32(cenStart, true)).toBe(0x02014b50);
    // Første fils data ligger lige efter header + navn.
    const navnLen = dv.getUint16(26, true);
    const navn = new TextDecoder().decode(zip.slice(30, 30 + navnLen));
    expect(navn).toBe("_a.txt");
    expect(new TextDecoder().decode(zip.slice(30 + navnLen, 30 + navnLen + a.length))).toBe("hej æøå");
  });

  it("renser filnavne", () => {
    expect(sikkertZipNavn("..\\x/y:z")).toBe("_x_y_z");
    expect(sikkertZipNavn("")).toBe("fil");
  });
});

describe("kronerTilOere", () => {
  it.each([
    // Punktum + præcis 3 cifre = tusindtalsskilletegn.
    ["1.250", 125000],
    ["12.500", 1250000],
    ["1.250.000", 125000000],
    ["1.250,50", 125050],
    ["1.250,5", 125050],
    ["1250", 125000],
    ["1250,5", 125050],
    ["1250,50", 125050],
    ["1 250", 125000],
    ["1 250,50", 125050],
    ["1.250 kr.", 125000],
    ["12 kr.", 1200],
    ["12kr", 1200],
    ["  99,95  ", 9995],
    // Decimalpunktum uden komma (1-2 cifre).
    ["1250.5", 125050],
    ["1250.50", 125050],
    ["0,01", 1],
    // Tvetydigt eller ugyldigt.
    ["0", null],
    ["0,00", null],
    ["-5", null],
    ["abc", null],
    ["", null],
    ["1,234", null],
    ["1,2,3", null],
    ["1.25,00", null],
    ["12.50,00", null],
    ["1250.500", null],
    ["1.2.3", null],
    ["1.2500", null],
    ["12 50", null],
    ["1 25,00", null],
    ["1.250,", null],
    [",50", null],
    ["1e5", null],
    ["99999999999999999999", null],
  ])("%s -> %s", (ind, ud) => {
    expect(kronerTilOere(ind)).toBe(ud);
  });

  it("giver en dansk fejltekst", () => {
    for (const v of ["1,234", "abc", "1.25,00", "", "-5", "0"]) {
      const r = fortolkKroner(v);
      expect("fejl" in r && r.fejl.length > 5).toBe(true);
    }
    expect(fortolkKroner("1,234")).toEqual({ fejl: "Skriv højst 2 decimaler efter kommaet, fx 1.250,50." });
    expect(fortolkKroner("1.250")).toEqual({ oere: 125000 });
  });
});

describe("tekster til sælgeren", () => {
  const raekke = {
    id: "00000000-0000-4000-8000-000000000001",
    trade_id: "00000000-0000-4000-8000-000000000002",
    saelger_id: "00000000-0000-4000-8000-000000000003",
    transportoer: "dao" as const,
    status: "afventer_bidhamr" as const,
    kravbeloeb_oere: 250000,
    godkendt_beloeb_oere: null,
    afvisningsgrund: null,
    annulleret_grund: null,
    annulleret_auto: false,
    annulleret_kl: null,
    aktiv_fra_kl: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
    anmeldt_kl: null,
    afgjort_kl: null,
    udbetalt_kl: null,
    bank_status: null,
    bank_fejlet_kl: null,
    sag_aendret_kl: null,
    sag_aendret_kvitteret_kl: null,
  };
  const trin = (b: { input: { noegle: string } }[]) => b.map((x) => x.input.noegle.split(":")[2]);

  it("giver én besked pr. trin med faste nøgler - aldrig omdeling.info eller forsikring", async () => {
    const { reklamationBeskeder } = await import("@/lib/reklamation/notifikationer");
    const aktiv = new Date(raekke.aktiv_fra_kl).getTime();
    const kl = new Date().toISOString();
    const t = new Date(kl).getTime();

    const opr = reklamationBeskeder(raekke);
    expect(opr.map((x) => x.input.noegle)).toEqual([`reklamation:${raekke.id}:oprettet:${aktiv}`]);
    expect(opr[0].input.titel).toBe("Vi reklamerer hos DAO for dig");
    expect(opr[0].input.tekst).toContain("du skal ikke selv gøre noget");
    expect(opr[0].input.tekst).toContain("køberen har fået pengene tilbage");
    expect(opr[0].input.tekst).toContain("2.500 kr.");

    const anmeldt = reklamationBeskeder({ ...raekke, status: "anmeldt", anmeldt_kl: kl });
    expect(anmeldt.map((x) => x.input.noegle)).toEqual([`reklamation:${raekke.id}:anmeldt:${t}`]);

    const godkendt = reklamationBeskeder({ ...raekke, status: "godkendt", anmeldt_kl: kl, afgjort_kl: kl, godkendt_beloeb_oere: 125050 });
    expect(trin(godkendt)).toEqual(["godkendt"]);
    expect(godkendt[0].input.tekst).toContain("1.250,5 kr.");
    expect(godkendt[0].input.tekst).toContain("Vi udbetaler pengene til dig, når DAO har betalt os");

    const afvist = reklamationBeskeder({ ...raekke, status: "afvist", afgjort_kl: kl, afvisningsgrund: "Ikke transportskade" });
    expect(trin(afvist)).toEqual(["afvist"]);
    expect(afvist[0].input.tekst).toContain("Begrundelse fra DAO: Ikke transportskade.");

    const udbetalt = reklamationBeskeder({ ...raekke, status: "udbetalt", udbetalt_kl: kl, godkendt_beloeb_oere: 250000 });
    expect(trin(udbetalt)).toEqual(["udbetalt"]);
    expect(udbetalt[0].input.tekst).toContain("Vi har udbetalt 2.500 kr. i erstatning");

    const bankFejl = reklamationBeskeder({
      ...raekke,
      status: "udbetalt",
      udbetalt_kl: kl,
      godkendt_beloeb_oere: 250000,
      bank_status: "failed",
      bank_fejlet_kl: kl,
    });
    expect(trin(bankFejl)).toEqual(["udbetalt", "bank_fejlet"]);
    expect(bankFejl[1].input.link).toBe("/konto#udbetaling");

    const staff = reklamationBeskeder({ ...raekke, status: "annulleret", annulleret_kl: kl, annulleret_grund: "Test" });
    expect(trin(staff)).toEqual(["annulleret"]);

    for (const x of [...opr, ...anmeldt, ...godkendt, ...afvist, ...udbetalt, ...bankFejl, ...staff]) {
      const alt = `${x.input.titel} ${x.input.tekst}`.toLowerCase();
      expect(alt).not.toContain("forsikring");
      expect(alt).not.toContain("omdeling");
      // Aldrig "kr.." (kroner() slutter selv med punktum).
      expect(x.input.tekst).not.toContain("kr..");
    }
    for (const x of [...opr, ...anmeldt, ...godkendt, ...afvist, ...udbetalt, ...staff]) {
      expect(x.input.link).toBe(`/mine-handler/${raekke.trade_id}#reklamation`);
    }
  });

  it("auto-annullering, genopståen og ændret sag", async () => {
    const { reklamationBeskeder } = await import("@/lib/reklamation/notifikationer");
    const aktiv = new Date(raekke.aktiv_fra_kl).getTime();
    const annKl = new Date().toISOString();
    // Auto-annulleringen meldes først efter en time.
    expect(reklamationBeskeder({ ...raekke, status: "annulleret", annulleret_auto: true, annulleret_kl: annKl })).toEqual([]);
    const auto = reklamationBeskeder(
      { ...raekke, status: "annulleret", annulleret_auto: true, annulleret_kl: annKl },
      Date.now() + 3600 * 1000,
    );
    expect(trin(auto)).toEqual(["auto_annulleret"]);
    expect(auto[0].kraever).toBe(`reklamation:${raekke.id}:oprettet:${aktiv}`);
    expect(auto[0].input.link).toBe(`/mine-handler/${raekke.trade_id}#sag`);

    // Genopstået: ny nøgle.
    const ny = reklamationBeskeder({ ...raekke, aktiv_fra_kl: annKl });
    expect(ny.map((x) => x.input.noegle)).toEqual([`reklamation:${raekke.id}:oprettet:${new Date(annKl).getTime()}`]);

    // Sagen ændret efter anmeldelsen -> besked; kvitteret -> "fortsætter".
    const aendretKl = new Date().toISOString();
    const aendret = reklamationBeskeder({ ...raekke, status: "godkendt", sag_aendret_kl: aendretKl });
    expect(trin(aendret)).toEqual(["sag_aendret"]);
    const kvit = reklamationBeskeder({ ...raekke, status: "anmeldt", sag_aendret_kl: aendretKl, sag_aendret_kvitteret_kl: aendretKl });
    expect(trin(kvit)).toEqual(["kvitteret"]);
    expect(kvit[0].kraever).toBe(`reklamation:${raekke.id}:sag_aendret:${new Date(aendretKl).getTime()}`);
    expect(kvit[0].input.tekst).toContain("Vi har kigget på sagen");
    const kvitSys = reklamationBeskeder({
      ...raekke,
      status: "anmeldt",
      sag_aendret_kl: aendretKl,
      sag_aendret_kvitteret_kl: aendretKl,
      sag_aendret_kvitteret_af: "00000000-0000-4000-8000-0000000b1d00",
    });
    expect(kvitSys[0].input.tekst).not.toContain("kigget");
  });

  it("statustekster og trin til sælgeren", () => {
    for (const s of ["afventer_bidhamr", "anmeldt", "godkendt", "afvist", "udbetalt", "annulleret"] as const) {
      const t = reklamationStatusSaelger(s, "dao").toLowerCase();
      expect(t).not.toContain("forsikring");
      expect(t).not.toContain("omdeling");
    }
    expect(reklamationStatusSaelger("afventer_bidhamr", "dao")).toBe("Vi reklamerer hos DAO for dig");
    expect(reklamationTrin("afventer_bidhamr")).toEqual({ trin: 0, faerdig: false });
    expect(reklamationTrin("anmeldt")).toEqual({ trin: 1, faerdig: false });
    expect(reklamationTrin("godkendt")).toEqual({ trin: 2, faerdig: false });
    expect(reklamationTrin("udbetalt")).toEqual({ trin: 2, faerdig: true });
    expect(reklamationTrin("afvist").faerdig).toBe(true);
  });
});

describe("chefens udbetaling", () => {
  it("idempotency-nøgler er bundet til reklamationen og forsøget", async () => {
    const { payoutNoegle, transferGruppe, transferNoegle } = await import("@/lib/reklamation/udbetaling");
    const id = "00000000-0000-4000-8000-000000000001";
    expect(transferNoegle(id, 0)).toBe(`bidhamr-reklamation-transfer-${id}-0`);
    expect(transferNoegle(id, 1)).not.toBe(transferNoegle(id, 0));
    expect(payoutNoegle(id, 0)).toBe(`bidhamr-reklamation-payout-${id}-0`);
    expect(payoutNoegle(id, 0)).not.toBe(transferNoegle(id, 0));
    // Samme transfer_group som handlens betaling (stripeBetaling.ts).
    expect(transferGruppe("abc")).toBe("handel_abc");
  }, 60_000);

  it("markerer udbetalinger, der hænger eller er fejlet (samme regel som databasen)", async () => {
    const { erUdbetalingFejl } = await import("@/components/admin/reklamation/visning");
    const nu = Date.now();
    const iso = (msSiden: number) => new Date(nu - msSiden).toISOString();
    const tom = {
      status: "godkendt" as const,
      udbetaling_paabegyndt_kl: null,
      bank_status: null,
      transfer_tilbagefoert_kl: null,
      udbetalt_kl: null,
      bank_claimet_kl: null,
      bank_oprettet_kl: null,
    };
    expect(erUdbetalingFejl(tom, nu)).toBe(false);
    expect(erUdbetalingFejl({ ...tom, udbetaling_paabegyndt_kl: iso(60_000) }, nu)).toBe(false);
    expect(erUdbetalingFejl({ ...tom, udbetaling_paabegyndt_kl: iso(11 * 60_000) }, nu)).toBe(true);
    const udb = { ...tom, status: "udbetalt" as const, udbetalt_kl: iso(60_000) };
    expect(erUdbetalingFejl(udb, nu)).toBe(false);
    expect(erUdbetalingFejl({ ...udb, udbetalt_kl: iso(2 * 3600_000) }, nu)).toBe(true);
    expect(erUdbetalingFejl({ ...udb, bank_status: "oprettet" as const, bank_oprettet_kl: iso(3600_000) }, nu)).toBe(false);
    expect(erUdbetalingFejl({ ...udb, bank_status: "paid" as const }, nu)).toBe(false);
    expect(erUdbetalingFejl({ ...udb, bank_status: "failed" as const }, nu)).toBe(true);
    expect(erUdbetalingFejl({ ...udb, bank_status: "paid" as const, transfer_tilbagefoert_kl: iso(0) }, nu)).toBe(true);
  });
});

describe("Kvittering for ændret sag", () => {
  it("tillader kun kvittering, når betingelserne er opfyldt, eller årsagen er midlertidig", () => {
    expect(kanKvittere(null)).toBe(true);
    expect(kanKvittere("anke_venter")).toBe(true);
    expect(kanKvittere("ankefrist")).toBe(true);
    for (const a of ["ikke_refunderet", "saelger_beholder", "ikke_koebers_fordel", "indpakning", "ingen_forsendelse", ""]) {
      expect(kanKvittere(a)).toBe(false);
    }
  });

  it("har en tekst for hver årsag og en reserve for ukendte", () => {
    expect(betingelseTekst("saelger_beholder")).toContain("sælgeren");
    expect(betingelseTekst("noget_nyt")).toBe("betingelserne ikke er opfyldt");
    expect(betingelseTekst(null)).toBe("betingelserne ikke er opfyldt");
  });
});
