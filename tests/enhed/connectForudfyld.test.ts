// Forudfyldning af Stripe Connect-kontoen for firmaer (connect.ts).
import { describe, expect, it } from "vitest";
import { firmaForudfyldning, nyKontoParametre, stripeTelefon, type FirmaForudfyld } from "@/lib/betaling/connect";

const FIRMA: FirmaForudfyld = {
  firmanavn: "Testers Genbrug ApS",
  cvr: "12345678",
  adresse: "Ellegårdsvej 40",
  postnummer: "4684",
  bynavn: "Holmegaard",
  telefon: "12 34 56 78",
  kontaktEmail: "Kontakt@Firma.dk",
};

describe("stripeTelefon", () => {
  it("laver danske numre om til E.164", () => {
    expect(stripeTelefon("12345678")).toBe("+4512345678");
    expect(stripeTelefon("12 34 56 78")).toBe("+4512345678");
    expect(stripeTelefon("12-34-56-78")).toBe("+4512345678");
    expect(stripeTelefon("+45 12 34 56 78")).toBe("+4512345678");
    expect(stripeTelefon("0045 12345678")).toBe("+4512345678");
  });
  it("udelader numre, der ikke kan laves om med sikkerhed", () => {
    expect(stripeTelefon("1234567")).toBeNull();
    expect(stripeTelefon("+45 1234 5678 9")).toBeNull();
    expect(stripeTelefon("123456789")).toBeNull();
    expect(stripeTelefon("tlf. 12345678")).toBeNull();
    expect(stripeTelefon("")).toBeNull();
    expect(stripeTelefon(null)).toBeNull();
  });
  it("tager udenlandske numre med +", () => {
    expect(stripeTelefon("+46 70 123 45 67")).toBe("+46701234567");
  });
});

describe("firmaForudfyldning", () => {
  it("udfylder firmanavn, CVR, adresse, telefon og kontakt-e-mail", () => {
    expect(firmaForudfyldning(FIRMA)).toEqual({
      company: {
        name: "Testers Genbrug ApS",
        tax_id: "12345678",
        phone: "+4512345678",
        address: { line1: "Ellegårdsvej 40", postal_code: "4684", city: "Holmegaard", country: "DK" },
      },
      business_profile: {
        name: "Testers Genbrug ApS",
        support_email: "kontakt@firma.dk",
        support_phone: "+4512345678",
      },
    });
  });
  it("udelader ugyldige felter i stedet for at sende dem", () => {
    const f = firmaForudfyldning({ ...FIRMA, cvr: "1234", telefon: "abc", postnummer: "12", kontaktEmail: "ikke-en-mail" });
    expect(f.company.tax_id).toBeUndefined();
    expect(f.company.phone).toBeUndefined();
    expect(f.company.address).toBeUndefined();
    expect(f.company.name).toBe("Testers Genbrug ApS");
    expect(f.business_profile).toEqual({ name: "Testers Genbrug ApS" });
  });
});

describe("nyKontoParametre", () => {
  const base = { userId: "u1", email: "login@firma.dk", url: "https://bidhamr.dk" };

  it("privat bruger er uændret (ingen company, ingen firmafelter)", () => {
    const p = nyKontoParametre({ ...base, erFirma: false, firma: FIRMA });
    expect(p.business_type).toBe("individual");
    expect(p.company).toBeUndefined();
    expect(p.business_profile).toEqual({
      mcc: "5931",
      product_description: "Privat salg af brugte ting på BidHamr",
      url: "https://bidhamr.dk",
    });
    expect(p.email).toBe("login@firma.dk");
  });

  it("firma uden firmaer-række: company uden forudfyldning (som før)", () => {
    const p = nyKontoParametre({ ...base, erFirma: true, firma: null });
    expect(p.business_type).toBe("company");
    expect(p.company).toBeUndefined();
    expect(p.business_profile?.name).toBeUndefined();
  });

  it("firma: forudfyldt company og business_profile, resten uændret", () => {
    const p = nyKontoParametre({ ...base, erFirma: true, firma: FIRMA });
    expect(p.business_type).toBe("company");
    expect(p.company?.tax_id).toBe("12345678");
    expect(p.company?.address?.country).toBe("DK");
    expect(p.business_profile).toMatchObject({
      mcc: "5931",
      url: "https://bidhamr.dk",
      name: "Testers Genbrug ApS",
      support_email: "kontakt@firma.dk",
      support_phone: "+4512345678",
    });
    expect(p.settings?.payouts?.schedule?.interval).toBe("manual");
  });
});
