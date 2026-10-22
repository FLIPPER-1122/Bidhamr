// Firmaoplysningerne (e-handelsloven § 7) står ét sted i
// src/lib/firmaoplysninger.ts. Juradokumenterne og Supabase-mailskabelonerne
// kan ikke importere derfra - her tjekkes det, at de står ens alle steder.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIRMA, FIRMA_ADRESSE, FIRMA_LINJE } from "@/lib/firmaoplysninger";
import { BIDHAMR_CVR } from "@/lib/faktura/konfig";
import { bygMail } from "@/lib/mails/layout";
import { parseJura } from "@/lib/jura/juraDokument";

const rod = path.resolve(import.meta.dirname, "..", "..");
const laes = (...dele: string[]) => readFileSync(path.join(rod, ...dele), "utf8");

describe("firmaoplysninger", () => {
  it("firmalinjen er som aftalt", () => {
    expect(FIRMA_LINJE).toBe("BidHamr ApS · CVR 46836219 · Ellegårdsvej 40, 4684 Holmegaard · support@bidhamr.dk");
    expect(FIRMA.momsnr).toBe(`DK${FIRMA.cvr}`);
    expect(BIDHAMR_CVR).toBe(FIRMA.cvr);
  });

  it.each(["brugerbetingelser-udkast.md", "privatlivspolitik-udkast.md"])(
    "%s har navn, CVR, adresse og e-mail",
    (fil) => {
      const tekst = JSON.stringify(parseJura(laes("jura", fil)));
      expect(tekst).toContain(FIRMA.navn);
      expect(tekst).toContain(FIRMA.cvr);
      expect(tekst).toContain(FIRMA_ADRESSE);
      expect(tekst).toContain(FIRMA.email);
    },
  );

  it.each(["confirmation.html", "invite.html", "recovery.html"])("Supabase-skabelonen %s har firmalinjen", (fil) => {
    expect(laes("supabase", "templates", fil)).toContain(`${FIRMA.navn} · CVR ${FIRMA.cvr} · ${FIRMA_ADRESSE} · `);
  });

  it("mails' bundtekst har firmaoplysningerne", () => {
    const mail = bygMail({ preheader: "x", overskriftHtml: "x", afsnitHtml: ["x"], aarsag: "x" });
    expect(mail.text).toContain(FIRMA_LINJE);
    expect(mail.html).toContain(`CVR ${FIRMA.cvr}`);
    expect(mail.html).toContain(FIRMA_ADRESSE);
    expect(mail.html).toContain(`mailto:${FIRMA.email}`);
  });
});
