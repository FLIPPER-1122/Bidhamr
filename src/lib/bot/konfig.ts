// BidHamr-bot: konfiguration og rene regler (ingen server-afhængigheder, så
// enhedstestene kan bruge dem).
//
// Nøglen hedder ANTHROPIC_API_KEY. Mangler den, er botten skjult overalt
// (chatboblen vises ikke, og endpoints svarer "ikke tilgængelig") - den
// fejler aldrig. Modellen kommer fra BIDHAMR_BOT_MODEL med standard
// claude-haiku-5-5 (Filip, 27. okt. 2026). Effort er 'low'.

export const BOT_STANDARD_MODEL = "claude-haiku-5-5";
export const BOT_EFFORT = "low" as const;

// Længste besked fra brugeren (tegn). Samme loft i databasen (bot_ny_besked).
export const BOT_MAKS_TEGN = 1000;
// Antal tidligere beskeder, der sendes med til modellen.
export const BOT_MAKS_HISTORIK = 20;
// Loft over runder i værktøjsløkken pr. svar.
export const BOT_MAKS_RUNDER = 4;
// max_tokens pr. runde (thinking + svar).
export const BOT_MAKS_TOKENS = 4000;
// Loftet pr. døgn står i databasen (bot_ny_besked) - her kun til tekster.
export const BOT_LOFT_PR_DOEGN = 30;

export function botNoegle(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.ANTHROPIC_API_KEY?.trim();
  return v ? v : null;
}

export function botAktiv(env: NodeJS.ProcessEnv = process.env): boolean {
  return botNoegle(env) !== null;
}

export function botModel(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.BIDHAMR_BOT_MODEL?.trim();
  return v && /^[a-z0-9.-]{3,80}$/i.test(v) ? v : BOT_STANDARD_MODEL;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type BotInput = { samtaleId: string | null; besked: string };

// Validerer kroppen fra hjemmesiden og appen ({ samtaleId?, besked }).
export function laesBotInput(krop: unknown): BotInput | { fejl: string; kode: string } {
  if (!krop || typeof krop !== "object" || Array.isArray(krop)) return { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" };
  const k = krop as Record<string, unknown>;
  const samtale = k.samtaleId;
  if (samtale !== undefined && samtale !== null && (typeof samtale !== "string" || !UUID_RE.test(samtale))) {
    return { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" };
  }
  if (typeof k.besked !== "string") return { fejl: "Skriv en besked.", kode: "tom" };
  const besked = k.besked.replace(/\r\n?/g, "\n").trim();
  if (!besked) return { fejl: "Skriv en besked.", kode: "tom" };
  if (besked.length > BOT_MAKS_TEGN) {
    return { fejl: `Beskeden må højst være ${BOT_MAKS_TEGN.toLocaleString("da-DK")} tegn.`, kode: "for_lang" };
  }
  return { samtaleId: (samtale as string | null | undefined) ?? null, besked };
}

export function laesEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

// Svarkoderne fra bot_ny_besked som danske fejl (HTTP-status, tekst).
export function loftFejl(kode: string): { status: number; fejl: string; kode: string } {
  switch (kode) {
    case "loft_bruger":
    case "loft_ip":
      return {
        status: 429,
        kode,
        fejl: `Du har skrevet ${BOT_LOFT_PR_DOEGN} beskeder til BidHamr-bot det seneste døgn. Prøv igen senere, eller kontakt en rigtig medarbejder.`,
      };
    case "loft_alle":
      return { status: 429, kode, fejl: "BidHamr-bot har travlt lige nu. Prøv igen senere, eller kontakt en rigtig medarbejder." };
    case "samtale_fuld":
      return { status: 409, kode, fejl: "Samtalen er blevet lang. Start en ny samtale, eller kontakt en rigtig medarbejder." };
    case "ukendt_samtale":
      return { status: 409, kode, fejl: "Samtalen findes ikke længere. Start en ny samtale." };
    case "ugyldig_laengde":
      return { status: 400, kode, fejl: `Beskeden må højst være ${BOT_MAKS_TEGN.toLocaleString("da-DK")} tegn.` };
    default:
      return { status: 500, kode: "fejl", fejl: "Noget gik galt. Prøv igen om lidt." };
  }
}

// Priser i USD pr. million tokens (input, output, cache-læsning,
// cache-skrivning med 5 minutters TTL). Ukendt model: Opus-priser, så
// omkostningen hellere overvurderes end undervurderes.
type Priser = { input: number; output: number; cacheRead: number; cacheWrite: number };
const PRISER: Record<string, Priser> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};
const UKENDT: Priser = PRISER["claude-opus-5-5"];

export type BotForbrug = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function botPrisUsd(model: string, f: BotForbrug): number {
  const p = PRISER[model] ?? UKENDT;
  const usd = (f.input * p.input + f.output * p.output + f.cacheRead * p.cacheRead + f.cacheWrite * p.cacheWrite) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
