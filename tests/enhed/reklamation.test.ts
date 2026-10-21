import { describe, expect, it, vi } from "vitest";
import { crc32, lavZip, sikkertZipNavn } from "@/lib/reklamation/zip";
import { fortolkKroner, kronerTilOere, reklamationStatusSaelger } from "@/lib/reklamation/typer";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/notifikationer/send", () => ({ send: vi.fn() }));

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

describe("tekster", () => {
  it("bruger aldrig ordet forsikring", async () => {
    const { reklamationBeskeder } = await import("@/lib/reklamation/notifikationer");
    const raekke = {
      id: "00000000-0000-4000-8000-000000000001",
      trade_id: "00000000-0000-4000-8000-000000000002",
      saelger_id: "00000000-0000-4000-8000-000000000003",
      transportoer: "dao" as const,
      status: "afventer_saelger" as const,
      kravbeloeb_oere: 250000,
      annulleret_grund: null,
      annulleret_auto: false,
      annulleret_kl: null,
      aktiv_fra_kl: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
      gensendt_antal: 1,
      sag_aendret_kl: null,
      sag_aendret_kvitteret_kl: null,
    };
    const aktiv = new Date(raekke.aktiv_fra_kl).getTime();
    const b = reklamationBeskeder(raekke);
    expect(b.map((x) => x.input.noegle.split(":").slice(2).join(":"))).toEqual([
      `oprettet:${aktiv}`,
      "gensendt:1",
      `paamind:${aktiv}`,
    ]);
    for (const x of b) {
      expect(`${x.input.titel} ${x.input.tekst}`.toLowerCase()).not.toContain("forsikring");
      expect(x.input.link).toBe(`/mine-handler/${raekke.trade_id}#sag`);
    }
    expect(b[0].input.tekst).toContain("omdeling.info");
    expect(b[0].input.tekst).toContain("køberen har fået pengene tilbage");

    // L5: ingen "oprettet" efter annullering; auto-annullering kun, hvis
    // "oprettet" for samme aktivering er sendt.
    const annKl = new Date().toISOString();
    const auto = reklamationBeskeder({ ...raekke, status: "annulleret", annulleret_auto: true, annulleret_kl: annKl });
    expect(auto.map((x) => x.input.noegle.split(":")[2])).toEqual(["auto_annulleret"]);
    expect(auto[0].kraever).toBe(`reklamation:${raekke.id}:oprettet:${aktiv}`);
    const staff = reklamationBeskeder({ ...raekke, status: "annulleret", annulleret_kl: annKl, annulleret_grund: "Test" });
    expect(staff.map((x) => x.input.noegle.split(":")[2])).toEqual(["annulleret"]);
    expect(reklamationBeskeder({ ...raekke, status: "anmeldt" }).map((x) => x.input.noegle.split(":")[2])).toEqual(["gensendt"]);

    // Genopstået: ny nøgle.
    const ny = reklamationBeskeder({ ...raekke, aktiv_fra_kl: annKl, gensendt_antal: 0 });
    expect(ny.map((x) => x.input.noegle)).toEqual([`reklamation:${raekke.id}:oprettet:${new Date(annKl).getTime()}`]);

    // Sagen ændret efter anmeldelsen -> besked; kvitteret -> ny besked.
    const aendretKl = new Date().toISOString();
    const aendret = reklamationBeskeder({ ...raekke, status: "anmeldt", gensendt_antal: 0, sag_aendret_kl: aendretKl });
    expect(aendret.map((x) => x.input.noegle.split(":")[2])).toEqual(["sag_aendret"]);
    const kvit = reklamationBeskeder({
      ...raekke,
      status: "anmeldt",
      gensendt_antal: 0,
      sag_aendret_kl: aendretKl,
      sag_aendret_kvitteret_kl: aendretKl,
    });
    expect(kvit.map((x) => x.input.noegle.split(":")[2])).toEqual(["kvitteret"]);
    expect(kvit[0].kraever).toBe(`reklamation:${raekke.id}:sag_aendret:${new Date(aendretKl).getTime()}`);

    for (const x of [...auto, ...staff, ...aendret, ...kvit]) {
      expect(`${x.input.titel} ${x.input.tekst}`.toLowerCase()).not.toContain("forsikring");
    }
    for (const s of ["afventer_saelger", "anmeldt", "godkendt", "afvist", "fravalgt", "annulleret"] as const) {
      expect(reklamationStatusSaelger(s, "gls").toLowerCase()).not.toContain("forsikring");
    }
  });
});
