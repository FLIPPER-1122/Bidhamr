import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hentBruger } from "@/lib/supabase/bruger";
import { hentBetalingsstatus } from "@/app/actions/betaling";
import { hentCheckoutAction } from "@/app/actions/fragt";
import CheckoutSide from "@/components/checkout/CheckoutSide";
import CheckoutFejl from "@/components/checkout/CheckoutFejl";

// Checkout for vinderen (ROADMAP-BESLUTNINGER: "Ingen automatisk betaling" -
// alle vindere ender her): levering (pakkeshop, hjem eller afhentning),
// prisoversigt og betaling på én side. Handelssiden sender køberen hertil,
// så længe handlen ikke er betalt (HandelDetalje).
//
// Alle beløb kommer fra serveren (betalingsrækken og auktionens låste
// fragtpriser). Leveringsvalget gemmes med gemLeveringsvalgAction, før
// betalingen startes - serveren afviser betaling uden valg ("vaelg_levering").

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Betal for din vare", robots: { index: false, follow: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BetalPage({ params }: { params: Promise<{ trade_id: string }> }) {
  const { trade_id } = await params;
  const handelSti = `/mine-handler/${encodeURIComponent(trade_id)}`;
  const user = await hentBruger();
  if (!user) redirect(`/login?redirect=${handelSti}/betal`);
  if (!UUID.test(trade_id)) notFound();

  const supabase = await createClient();
  const { data: handel } = await supabase
    .from("trades")
    .select("id, auction_id, buyer_id, seller_id, status")
    .eq("id", trade_id)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .maybeSingle<{ id: string; auction_id: string; buyer_id: string; seller_id: string; status: string }>();
  if (!handel) notFound();
  // Sælgeren og en betalt/annulleret handel hører til på handelssiden.
  if (handel.buyer_id !== user.id || handel.status !== "afventer_betaling") redirect(handelSti);

  const [{ data: auktion }, { data: saelger }, { data: mig }, betaling, checkoutSvar] = await Promise.all([
    supabase.from("auctions").select("titel, billeder, erhverv").eq("id", handel.auction_id).maybeSingle(),
    supabase.from("users").select("navn").eq("id", handel.seller_id).maybeSingle<{ navn: string | null }>(),
    supabase.from("users").select("navn").eq("id", user.id).maybeSingle<{ navn: string | null }>(),
    hentBetalingsstatus(handel.id),
    hentCheckoutAction(handel.id),
  ]);

  const vare = {
    titel: (auktion?.titel as string | undefined) ?? "Slettet auktion",
    billede: ((auktion?.billeder as string[] | null) ?? [])[0] ?? null,
    saelgerNavn: saelger?.navn ?? null,
    // Erhvervshandel: ingen chat med firmaet.
    erhverv: auktion?.erhverv === true,
  };

  if ("fejl" in betaling || !betaling.erKoeber) {
    return <CheckoutFejl handelSti={handelSti} tekst={"fejl" in betaling ? betaling.fejl : "Betalingen findes ikke."} />;
  }
  if ("fejl" in checkoutSvar) {
    return <CheckoutFejl handelSti={handelSti} tekst={checkoutSvar.fejl} />;
  }
  // Betalt i en anden fane, mens siden blev hentet.
  if (betaling.status === "betalt") redirect(`${handelSti}?betaling=retur`);

  return (
    <CheckoutSide
      tradeId={handel.id}
      vare={vare}
      status={betaling}
      checkout={checkoutSvar.checkout}
      standardNavn={mig?.navn ?? null}
    />
  );
}
