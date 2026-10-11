// Til sidst (filerne køres i navneorden): Stripe og databasen skal passe
// sammen efter alle scenarierne. For hver sælgers testkonto: saldoen hos
// Stripe (tilgængelig + afventende) = det, databasen siger, der står på
// kontoen for betalte, ikke-udbetalte handler (skyldigOere - samme regel som
// før hver udbetaling). Og den rigtige overvågning finder ingen afvigelse.
import { describe, expect, it } from "vitest";
import { skyldigOere } from "@/lib/betaling/udbetaling";
import { koerBetalingsovervaagning } from "@/lib/betaling/overvaagning";
import { admin, kontoFor, saldo } from "./handel";
import { SAELGER, SAELGER_BANK_FEJLER } from "./brugere";

describe("slutafstemning", () => {
  for (const s of [SAELGER, SAELGER_BANK_FEJLER]) {
    it(`${s.email}: saldo hos Stripe = databasens tal`, async () => {
      const konto = kontoFor(s);
      const b = await saldo(konto);
      const skyldig = await skyldigOere(admin(), s.id, konto);
      expect(b.tilgaengelig + b.afventer).toBe(skyldig);
    });
  }

  it("overvågningen finder ingen saldo-afvigelse på testkontiene", async () => {
    const r = await koerBetalingsovervaagning(true);
    expect(r.koert).toBe(1);
    for (const s of [SAELGER, SAELGER_BANK_FEJLER]) {
      const { count } = await admin()
        .from("drift_tilfaelde")
        .select("noegle", { count: "exact", head: true })
        .is("loest_kl", null)
        .in("noegle", [`saldo:${kontoFor(s)}`, `saldo-ingen-adgang:${kontoFor(s)}`]);
      expect(count ?? 0).toBe(0);
    }
  });
});
