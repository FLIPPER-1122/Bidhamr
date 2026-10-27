import "server-only";

// Den lukkede "før lancering"-udgave (Filip, 26. okt. 2026): før lancering må
// besøgende uden adgang til den lukkede app KUN se /coming-soon, erhverv
// (/erhverv, /erhverv/formular) og de lovpligtige sider (/privatliv,
// /betingelser, /dsa) - uden sitets menu, søgning og footer-links, og uden
// cookie-banner (kun nødvendige cookies, så samtykke er ikke påkrævet).
// Gaten i src/lib/supabase/middleware.ts sender alt andet til /coming-soon.
//
// Adgang til den lukkede app = staff (chef, admin, medarbejder, saelger),
// firmakonti og beta-testere - de ser siden som i dag.
//
// Bruges til visning OG som adgangskontrol for BidHamr-bot: POST /api/bot og
// /api/bot/medarbejder afviser kaldet, når visLukketUdgave() er true
// (src/lib/bot/synlig.ts). Ændres reglen her, ændres også, hvem der kan
// bruge botten (og dermed hvem der kan koste penge hos Anthropic). Ved fejl
// svares true (den lukkede udgave), så en fejl lukker botten i stedet for at
// åbne den. Resten af siden: gaten (middleware) og databasen afgør, hvad man
// må. Identiteten kommer fra sessionens JWT (getClaims, lokalt) og den
// signerede rolle-cookie. Mangler cookien (gaten slår den ikke op på de offentlige
// sider), spørges databasen - kun for indloggede før lancering.
import { cache } from "react";
import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { foerLancering } from "@/lib/lancering";
import { ROLLE_COOKIE, laesRolleCookie, type GateIdentitet } from "@/lib/rolleCookie";
import { harAdgangTilLukketApp } from "@/lib/lukketUdgaveRegler";

export const visLukketUdgave = cache(async (): Promise<boolean> => {
  if (!foerLancering()) return false;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    const sub = data?.claims?.sub;
    const sessionId = data?.claims?.session_id;
    if (typeof sub !== "string" || !sub) return true;
    const fraCookie =
      typeof sessionId === "string"
        ? await laesRolleCookie((await cookies()).get(ROLLE_COOKIE)?.value, sub, sessionId)
        : null;
    if (fraCookie) return !harAdgangTilLukketApp(fraCookie);
    const [{ data: rolle }, { data: konto }, { data: beta }] = await Promise.all([
      supabase.rpc("min_rolle"),
      supabase.from("users").select("konto_type").eq("id", sub).maybeSingle<{ konto_type: string | null }>(),
      supabase.rpc("min_beta_adgang"),
    ]);
    const id: Pick<GateIdentitet, "kontoType" | "beta"> & { rolle: string | null } = {
      rolle: typeof rolle === "string" ? rolle : null,
      kontoType: konto?.konto_type ?? null,
      beta: beta === true,
    };
    return !harAdgangTilLukketApp(id);
  } catch (err) {
    unstable_rethrow(err);
    // Fejl: vis den lukkede udgave (den viser mindst).
    return true;
  }
});
