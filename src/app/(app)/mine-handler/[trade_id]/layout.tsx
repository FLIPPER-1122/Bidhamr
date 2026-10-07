import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Ikke logget ind: layoutet kender ikke understien (fx /kvittering), så
  // login-redirect overlades til siderne, der hver sender tilbage til deres
  // egen sti. HVER side under [trade_id] skal derfor selv redirecte, når
  // brugeren ikke er logget ind (RLS viser alligevel intet for anon).
  if (!user) return <>{children}</>;

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(trade_id)) notFound();

  const { data: handel, error } = await supabase
    .from("trades")
    .select("id")
    .eq("id", trade_id)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`Handlen kunne ikke hentes: ${error.message}`);
  if (!handel) notFound();

  return <>{children}</>;
}
