// BidHamr-bot: chatboblen nederst på alle sider i (app)-layoutet.
// Vises kun, når ANTHROPIC_API_KEY er sat, og (før lancering) kun for dem,
// der har adgang til den lukkede app - se src/lib/bot/synlig.ts. Alle andre
// får intet (heller ikke chattens JavaScript). Læg den i en
// <Suspense fallback={null}>.
import dynamic from "next/dynamic";
import { botSynligPaaHjemmesiden } from "@/lib/bot/synlig";
import { sessionBrugerId } from "@/lib/supabase/bruger";
import { BOT_MAKS_TEGN } from "@/lib/bot/konfig";
import { brugerNoegle } from "@/lib/bot/brugerNoegle";

const BotChat = dynamic(() => import("./BotChat"));

export default async function BotBoble() {
  if (!(await botSynligPaaHjemmesiden())) return null;
  const brugerId = await sessionBrugerId();
  return <BotChat brugerNoegle={brugerNoegle(brugerId)} maksTegn={BOT_MAKS_TEGN} />;
}
