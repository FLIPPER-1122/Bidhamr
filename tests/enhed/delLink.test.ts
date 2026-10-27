// Del auktion (src/lib/del/delLink.ts): linket indeholder kun auktionens id
// (og evt. henvisningskoden), og delingsadresserne er kodet korrekt.
import { describe, expect, it } from "vitest";
import { auktionDelUrl, delMaal, delTekst, HENVISNING_PARAM } from "@/lib/del/delLink";

const ID = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc";

describe("auktionDelUrl", () => {
  it("kun /auktion/<id> på det aktuelle domæne - sti og parametre fra siden droppes", () => {
    expect(auktionDelUrl("https://bidhamr.dk/auktion/x?betaling=pi_123#y", ID)).toBe(`https://bidhamr.dk/auktion/${ID}`);
  });

  it("henvisningskoden kommer med, når den er gyldig", () => {
    expect(auktionDelUrl("https://bidhamr.dk", ID, "Ven-42ab")).toBe(`https://bidhamr.dk/auktion/${ID}?${HENVISNING_PARAM}=Ven-42ab`);
  });

  it("ugyldige koder droppes (ingen e-mail, mellemrum eller ekstra parametre)", () => {
    for (const k of ["a@b.dk", "ab cd", "x&y=1", "abc", "a".repeat(41)]) {
      expect(auktionDelUrl("https://bidhamr.dk", ID, k), k).toBe(`https://bidhamr.dk/auktion/${ID}`);
    }
  });

  it("afviser andet end et uuid og andre protokoller", () => {
    expect(auktionDelUrl("https://bidhamr.dk", "../konto")).toBeNull();
    expect(auktionDelUrl("javascript:alert(1)", ID)).toBeNull();
  });
});

describe("delMaal", () => {
  const url = `https://bidhamr.dk/auktion/${ID}`;
  const u = encodeURIComponent(url);

  it("Facebook, SMS, e-mail og Messenger-appen", () => {
    const m = delMaal(url, "Cykel & hjelm");
    expect(m.facebook).toBe(`https://www.facebook.com/sharer/sharer.php?u=${u}`);
    expect(m.messengerApp).toBe(`fb-messenger://share/?link=${u}`);
    expect(m.sms.startsWith("sms:?&body=")).toBe(true);
    expect(decodeURIComponent(m.sms.slice("sms:?&body=".length))).toBe(`Se "Cykel & hjelm" på BidHamr: ${url}`);
    expect(m.email).toContain(`subject=${encodeURIComponent('Se "Cykel & hjelm" på BidHamr')}`);
  });

  it("Messenger på computeren kun med et gyldigt app-id", () => {
    expect(delMaal(url, "x").messengerWeb).toBeNull();
    expect(delMaal(url, "x", "abc").messengerWeb).toBeNull();
    expect(delMaal(url, "x", "1234567890").messengerWeb).toBe(
      `https://www.facebook.com/dialog/send?app_id=1234567890&link=${u}&redirect_uri=${u}`,
    );
  });

  it("delTekst forkorter lange titler", () => {
    expect(delTekst("y".repeat(100))).toBe(`Se "${"y".repeat(77)}..." på BidHamr`);
  });
});
