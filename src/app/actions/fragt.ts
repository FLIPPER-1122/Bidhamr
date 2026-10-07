"use server";

// Fragtlabels på handelssiden (bag flaget FRAGT_LABELS_AKTIV=true).
// Brugeren verificeres altid med auth her; selve oprettelsen sker med
// service-role i src/lib/fragt/server.ts, som tjekker sælgeren igen under lås.
// Den eksisterende "Send pakke" (sporingsnummer + pakkebilleder) er uændret.
import { revalidatePath } from "next/cache";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { fragtLabelsAktiv } from "@/lib/fragt";
import { erPakkestoerrelse } from "@/lib/fragt/types";
import {
  FRAGT_LABEL_BUCKET,
  annullerUdgaaendeForsendelse,
  opretUdgaaendeForsendelse,
} from "@/lib/fragt/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IKKE_AKTIV = "Fragtlabels er ikke slået til endnu.";

export type MinForsendelse = {
  id: string;
  status: string;
  pakkestoerrelse: string;
  sporingsnummer: string | null;
  // Labelen og QR-koden kan kun ses af den rette part (sælgeren for en
  // udgående) - hentes via mine_forsendelse_label, ikke fra tabellen.
  har_label: boolean;
  qr_kode: string | null;
  oprettet_kl: string;
  afleveret_kl: string | null;
  klar_til_afhentning_kl: string | null;
  leveret_kl: string | null;
  returneret_kl: string | null;
};

async function brugerOgHandel(tradeId: string) {
  if (typeof tradeId !== "string" || !UUID.test(tradeId)) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return null;
  const { data: handel } = await supabase
    .from("trades")
    .select("id, seller_id, buyer_id, status, afhentning")
    .eq("id", tradeId)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .maybeSingle<{ id: string; seller_id: string; buyer_id: string; status: string; afhentning: boolean }>();
  if (!handel) return null;
  return { supabase, user, handel };
}

type ForsendelseRaekke = Omit<MinForsendelse, "har_label" | "qr_kode">;
type LabelRaekke = { label_sti: string | null; qr_kode: string | null };

// Labelens sti og QR-kode, hvis brugeren må se dem (mine_forsendelse_label:
// sælgeren for en udgående, køberen for en retur, og staff).
async function hentLabel(
  supabase: Awaited<ReturnType<typeof createClient>>,
  forsendelseId: string,
): Promise<LabelRaekke | null> {
  const { data, error } = await supabase.rpc("mine_forsendelse_label", { p_forsendelse: forsendelseId });
  if (error) {
    console.error("mine_forsendelse_label fejlede:", error.message);
    return null;
  }
  const raekke = (Array.isArray(data) ? data[0] : data) as LabelRaekke | undefined;
  return raekke ?? null;
}

// Den aktive udgående forsendelse på handlen (læses med brugerens egen
// session - RLS: kun køber, sælger og staff).
export async function hentMinForsendelse(tradeId: string): Promise<MinForsendelse | null> {
  const r = await brugerOgHandel(tradeId);
  if (!r) return null;
  const { data } = await r.supabase
    .from("forsendelser")
    .select(
      "id, status, pakkestoerrelse, sporingsnummer, oprettet_kl, afleveret_kl, klar_til_afhentning_kl, leveret_kl, returneret_kl",
    )
    .eq("trade_id", tradeId)
    .eq("type", "udgaaende")
    .not("status", "in", "(annulleret,fejlet)")
    .order("oprettet_kl", { ascending: false })
    .limit(1)
    .maybeSingle<ForsendelseRaekke>();
  if (!data) return null;
  const label = await hentLabel(r.supabase, data.id);
  return { ...data, har_label: Boolean(label?.label_sti), qr_kode: label?.qr_kode ?? null };
}

export async function lavFragtlabel(
  tradeId: string,
  pakkestoerrelse: string,
): Promise<{ ok: true } | { fejl: string }> {
  if (!fragtLabelsAktiv()) return { fejl: IKKE_AKTIV };
  if (!erPakkestoerrelse(pakkestoerrelse)) return { fejl: "Vælg en pakkestørrelse." };
  const r = await brugerOgHandel(tradeId);
  if (!r) return { fejl: "Handlen findes ikke." };
  if (r.handel.seller_id !== r.user.id) return { fejl: "Kun sælgeren kan lave en fragtlabel." };
  if (r.handel.afhentning) return { fejl: "Handlen er en afhentning - der skal ikke laves fragtlabel." };
  if (r.handel.status !== "betaling_modtaget") {
    return { fejl: "Der kan kun laves fragtlabel, når køberen har betalt, og pakken ikke er sendt." };
  }
  const svar = await opretUdgaaendeForsendelse(tradeId, r.user.id, pakkestoerrelse);
  revalidatePath(`/mine-handler/${tradeId}`);
  return "fejl" in svar ? { fejl: svar.fejl } : { ok: true };
}

export async function annullerFragtlabel(
  tradeId: string,
  forsendelseId: string,
): Promise<{ ok: true } | { fejl: string }> {
  if (!fragtLabelsAktiv()) return { fejl: IKKE_AKTIV };
  if (typeof forsendelseId !== "string" || !UUID.test(forsendelseId)) {
    return { fejl: "Fragtlabelen findes ikke." };
  }
  const r = await brugerOgHandel(tradeId);
  if (!r || r.handel.seller_id !== r.user.id) return { fejl: "Fragtlabelen findes ikke." };
  const svar = await annullerUdgaaendeForsendelse(forsendelseId, r.user.id);
  revalidatePath(`/mine-handler/${tradeId}`);
  return svar;
}

// Kortlivet link til label-PDF'en. Stien hentes med mine_forsendelse_label,
// og linket signeres med brugerens egen session, så storage-RLS
// (fragt_label_maa_laese) også afgør adgangen.
export async function hentFragtlabelLink(
  forsendelseId: string,
): Promise<{ url: string } | { fejl: string }> {
  if (typeof forsendelseId !== "string" || !UUID.test(forsendelseId)) {
    return { fejl: "Fragtlabelen findes ikke." };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind." };
  const f = await hentLabel(supabase, forsendelseId);
  if (!f?.label_sti) return { fejl: "Fragtlabelen findes ikke." };
  const { data, error } = await supabase.storage
    .from(FRAGT_LABEL_BUCKET)
    .createSignedUrl(f.label_sti, 300);
  if (error || !data?.signedUrl) return { fejl: "Fragtlabelen kunne ikke hentes." };
  return { url: data.signedUrl };
}
