// Pengetestenes faste TEST-brugere på testdatabasen. Oprettes af
// tests/penge/global.ts første gang. Navnene starter med "TEST", og
// e-mailen er penge-…@test.bidhamr.dk.
export type PengeBruger = {
  id: string;
  email: string;
  navn: string;
  saelger?: boolean;
  bankFejler?: boolean;
};

export const SAELGER: PengeBruger = {
  id: "11111111-1111-4111-8111-0000000005e1",
  email: "penge-saelger@test.bidhamr.dk",
  navn: "TEST Penge Sælger",
  saelger: true,
};

// Sælger med en bankkonto, der afviser udbetalinger (payout.failed).
export const SAELGER_BANK_FEJLER: PengeBruger = {
  id: "11111111-1111-4111-8111-0000000005e2",
  email: "penge-saelger-bankfejl@test.bidhamr.dk",
  navn: "TEST Penge Bankfejl",
  saelger: true,
  bankFejler: true,
};

export const KOEBER: PengeBruger = {
  id: "11111111-1111-4111-8111-0000000005e3",
  email: "penge-koeber@test.bidhamr.dk",
  navn: "TEST Penge Køber",
};

// En tredje bruger, der prøver at betale/se andres handler.
export const FREMMED: PengeBruger = {
  id: "11111111-1111-4111-8111-0000000005e4",
  email: "penge-fremmed@test.bidhamr.dk",
  navn: "TEST Penge Fremmed",
};

export const BRUGERE = [SAELGER, SAELGER_BANK_FEJLER, KOEBER, FREMMED] as const;

// Seed-brugeren chef@test.bidhamr.dk (staff-handlinger som "Ikke afhentet").
export const CHEF_ID = "11111111-1111-4111-8111-000000000004";

export type PengeKontekst = {
  koersel: string;
  // sælgerens bruger-id -> Stripe Connect-testkonto (ny for hver kørsel)
  konti: Record<string, string>;
};
