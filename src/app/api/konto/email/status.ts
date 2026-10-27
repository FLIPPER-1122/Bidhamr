import type { EmailSkiftKode } from "@/lib/emailSkift";

// HTTP-status for fejlkoderne fra src/lib/emailSkift.ts (appens endpoints).
export const EMAIL_SKIFT_STATUS: Record<EmailSkiftKode, number> = {
  email: 400,
  samme_email: 400,
  kode_forkert: 400,
  kode_udloebet: 400,
  optaget: 409,
  forkert_adgangskode: 403,
  staff: 403,
  firma: 403,
  suspenderet: 403,
  lukket: 403,
  slettet: 403,
  for_mange: 429,
  ikke_tilgaengelig: 503,
  fejl: 500,
};
