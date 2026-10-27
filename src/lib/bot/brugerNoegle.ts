import "server-only";

import { createHash } from "node:crypto";

// Til chatboblen på hjemmesiden (BotChat.tsx): en kort hash af bruger-id'et,
// så samtalen i sessionStorage kan ryddes, når en anden logger ind eller
// brugeren logger ud - uden at selve id'et ligger i browseren. Ingen
// hemmelighed og ingen adgangskontrol: serveren tjekker selv, hvem samtalen
// tilhører (bot_ny_besked og bot_overdrag).
export function brugerNoegle(brugerId: string | null): string | null {
  if (!brugerId) return null;
  return createHash("sha256").update(`bidhamr-bot-bruger|${brugerId}`).digest("hex").slice(0, 24);
}
