// Kører før hver testfil (vitest setupFiles): miljø, vagter og de få
// Next-funktioner, der ikke findes uden for en Next-forespørgsel.
//
// Kun tre ting er erstattet - ALT andet er den rigtige kode, den rigtige
// testdatabase og Stripes rigtige testmiljø:
//   - next/cache (revalidatePath/revalidateTag): ingen Next-cache i testene.
//   - @/lib/supabase/server (createClient): klienten for den bruger, testen
//     er "logget ind" som (tests/penge/session.ts) - en rigtig Supabase-
//     session med RLS, ikke service role.
//   - Webhook-hemmeligheden: testene signerer selv deres events med en
//     tilfældig hemmelighed (webhooken verificerer signaturen som altid).
import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { indlaesMiljoe } from "./miljoe";

indlaesMiljoe();
process.env.STRIPE_WEBHOOK_SECRET = `whsec_pengetest_${randomBytes(24).toString("hex")}`;

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: <T,>(fn: T) => fn,
}));

vi.mock("@/lib/supabase/server", async () => {
  const { aktivKlient } = await import("./session");
  return { createClient: async () => aktivKlient() };
});
