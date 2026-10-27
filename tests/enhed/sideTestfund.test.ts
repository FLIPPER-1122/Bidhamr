import { describe, expect, it } from "vitest";
import { kraeverLoginEfterLancering } from "@/lib/supabase/middleware";

// Efter lancering: kun sider, der kræver login, sender en besøgende uden
// login til /login. Alt andet (også ukendte adresser) går videre til Next og
// giver en rigtig 404.
describe("kraeverLoginEfterLancering", () => {
  it("beskyttede sider kræver login", () => {
    for (const sti of [
      "/konto",
      "/konto/slet",
      "/mine-handler",
      "/mine-handler/123",
      "/opret-auktion",
      "/beskeder",
      "/favoritter",
      "/notifikationer",
      "/andenchance/abc",
      "/velkommen",
      "/firma",
      "/firma/salg",
      "/profil/mig",
      "/admin",
      "/admin/erhverv",
      "/api/noget",
      "/dev/mails",
      "/auktion/abc/rediger",
    ]) {
      expect(kraeverLoginEfterLancering(sti), sti).toBe(true);
    }
  });

  it("ukendte og offentlige adresser kræver ikke login (404 eller siden selv)", () => {
    for (const sti of [
      "/findes-ikke-xyz",
      "/kontoen",
      "/firmaer",
      "/auktion/abc",
      "/profil/ikke-et-id",
      "/erhvervssaelger/xyz",
      "/auktioner",
    ]) {
      expect(kraeverLoginEfterLancering(sti), sti).toBe(false);
    }
  });
});
