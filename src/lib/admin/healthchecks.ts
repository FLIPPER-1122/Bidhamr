import "server-only";

// Ekstern vagt (Healthchecks.io): status for de checks, der pinges af
// betalings-cron og den daglige afstemning. Hentes KUN på serveren med en
// read-only nøgle (HEALTHCHECKS_LAESENOEGLE). Nøglen sendes aldrig til
// browseren og logges aldrig. Svaret caches 60 s i processen, og kaldet
// opgives efter 3 s, så forsiden aldrig venter længe på en ekstern tjeneste.
// Mangler nøglen, vises "Ikke sat op" i gråt - aldrig en falsk grøn.

export type VagtTone = "groen" | "gul" | "roed" | "graa";
export type Vagt = { navn: string; tone: VagtTone; tekst: string };

const URL = "https://healthchecks.io/api/v3/checks/";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 3_000;

// Navnene på checks hos Healthchecks og navnet på lampen.
const CHECKS = [
  { check: "Betalings-cron", lampe: "Ekstern vagt – Betalings-cron" },
  { check: "Daglig afstemning", lampe: "Ekstern vagt – Daglig afstemning" },
] as const;

type Check = { name?: string; status?: string; last_ping?: string | null };

let cache: { kl: number; v: Vagt[] } | null = null;

function siden(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "lige nu";
  if (min < 60) return `${min} min. siden`;
  const t = Math.floor(min / 60);
  return t < 48 ? `${t} t. siden` : `${Math.floor(t / 24)} dage siden`;
}

function tone(status: string | undefined): VagtTone {
  switch (status) {
    case "up":
    case "started":
      return "groen";
    case "grace":
      return "gul";
    case "down":
      return "roed";
    default:
      // new, paused eller ukendt.
      return "graa";
  }
}

const STATUS_NAVN: Record<string, string> = {
  up: "ok",
  started: "kører",
  grace: "forsinket",
  down: "nede",
  new: "ny – aldrig pinget",
  paused: "sat på pause",
};

export async function hentEksternVagt(): Promise<Vagt[]> {
  const noegle = process.env.HEALTHCHECKS_LAESENOEGLE?.trim();
  if (!noegle) return CHECKS.map((c) => ({ navn: c.lampe, tone: "graa", tekst: "Ikke sat op" }));
  if (cache && Date.now() - cache.kl < CACHE_MS) return cache.v;

  let v: Vagt[];
  try {
    const svar = await fetch(URL, {
      headers: { "X-Api-Key": noegle },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!svar.ok) throw new Error(`HTTP ${svar.status}`);
    const data = (await svar.json()) as { checks?: Check[] };
    const checks = Array.isArray(data.checks) ? data.checks : [];
    v = CHECKS.map((c) => {
      const fundet = checks.find((x) => x.name === c.check);
      if (!fundet) return { navn: c.lampe, tone: "graa" as const, tekst: "Ikke fundet hos Healthchecks" };
      const t = tone(fundet.status);
      const ping = fundet.last_ping ? ` · ping ${siden(fundet.last_ping)}` : "";
      return { navn: c.lampe, tone: t, tekst: `${STATUS_NAVN[fundet.status ?? ""] ?? fundet.status ?? "ukendt"}${ping}` };
    });
  } catch (err) {
    // Kun fejltypen - aldrig nøglen eller headers.
    console.error("Healthchecks kunne ikke hentes:", err instanceof Error ? err.name : "ukendt fejl");
    v = CHECKS.map((c) => ({ navn: c.lampe, tone: "gul", tekst: "Kunne ikke hentes lige nu" }));
  }
  cache = { kl: Date.now(), v };
  return v;
}
