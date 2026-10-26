// Før firmapakke-testen mod Stripe: miljøvagten (kun testdatabasen og
// Stripes testnøgle - stopper ellers) og next/cache uden Next.
import { vi } from "vitest";
import { indlaesMiljoe } from "../penge/miljoe";

indlaesMiljoe();

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: <T,>(fn: T) => fn,
}));
