import { describe, expect, it, vi } from "vitest";
import { crc32, lavZip, sikkertZipNavn } from "@/lib/reklamation/zip";
import { kronerTilOere, reklamationStatusSaelger } from "@/lib/reklamation/typer";

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
    ["1.250,50", 125050],
    ["1250", 125000],
    ["1250.5", 125050],
    ["12 kr.", 1200],
    ["0", null],
    ["-5", null],
    ["abc", null],
    ["1,234", null],
  ])("%s -> %s", (ind, ud) => {
    expect(kronerTilOere(ind)).toBe(ud);
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
    };
    const b = reklamationBeskeder(raekke);
    expect(b.map((x) => x.input.noegle.split(":")[2])).toEqual(["oprettet", "gensendt", "paamind"]);
    for (const x of b) {
      expect(`${x.input.titel} ${x.input.tekst}`.toLowerCase()).not.toContain("forsikring");
      expect(x.input.link).toBe(`/mine-handler/${raekke.trade_id}#sag`);
    }
    expect(b[0].input.tekst).toContain("omdeling.info");
    expect(reklamationBeskeder({ ...raekke, status: "annulleret", annulleret_auto: true })).toEqual([]);
    for (const s of ["afventer_saelger", "anmeldt", "godkendt", "afvist", "fravalgt", "annulleret"] as const) {
      expect(reklamationStatusSaelger(s, "gls").toLowerCase()).not.toContain("forsikring");
    }
  });
});
