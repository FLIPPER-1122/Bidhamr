import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { bekraeftetBruger, hentBruger, sessionBrugerId } from "@/lib/supabase/bruger";

// Adgangstjek for en handel. Ligger i et layout og ikke kun i page.tsx:
// layoutet ligger uden for loading.tsx-grænsen, så notFound() giver en rigtig
// 404-status, før skelettet streames (samme mønster som auktion/[id]).
// Listen /mine-handler ligger i route-gruppen (liste), så dens loading.tsx
// ikke omslutter dette layout.
//
// Medlemskab tjekkes eksplicit: RLS tillader også staff, men handlen (og den
// private chat) må kun ses af køber og sælger her - staff bruger admin-panelet.
export default async function HandelLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ trade_id: string }>;
}) {
  const { trade_id } = await params;
  const supabase = await createClient();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const opslag = (brugerId: string) =>
    supabase
      .from("trades")
      .select("id")
      .eq("id", trade_id)
      .or(`buyer_id.eq.${brugerId},seller_id.eq.${brugerId}`)
      .maybeSingle<{ id: string }>();
  // Handlen slås op SAMTIDIG med valideringen af brugeren (id'et fra
  // sessionens JWT, tjekket lokalt) - men bruges kun, hvis getUser bekræfter
  // præcis den bruger. Brugeren deles med siden (cache() i
  // src/lib/supabase/bruger.ts): ét getUser-kald.
  const sessionId = await sessionBrugerId();
  const [user, tidligt] = await Promise.all([
    sessionId ? bekraeftetBruger(sessionId) : hentBruger(),
    sessionId && UUID.test(trade_id) ? opslag(sessionId) : null,
  ]);
  // Ikke logget ind: layoutet kender ikke understien (fx /kvittering), så
  // login-redirect overlades til siderne, der hver sender tilbage til deres
  // egen sti. HVER side under [trade_id] skal derfor selv redirecte, når
  // brugeren ikke er logget ind (RLS viser alligevel intet for anon).
  if (!user) return <>{children}</>;

  if (!UUID.test(trade_id)) notFound();

  const { data: handel, error } = tidligt ?? (await opslag(user.id));
  if (error) throw new Error(`Handlen kunne ikke hentes: ${error.message}`);
  if (!handel) notFound();

  return <>{children}</>;
}
