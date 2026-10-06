export function formatTidTilbage(slutterKl: string): string {
  const msTilbage = new Date(slutterKl).getTime() - Date.now();

  if (msTilbage <= 0) return "Afsluttet";
  return formatVarighed(msTilbage);
}

// "2 dage 3 timer", "5 timer 12 min", "8 min".
export function formatVarighed(msTilbage: number): string {
  const minutter = Math.floor(msTilbage / 60000);
  const timer = Math.floor(minutter / 60);
  const dage = Math.floor(timer / 24);

  if (dage >= 1) {
    const resterendeTimer = timer % 24;
    return resterendeTimer > 0
      ? `${dage} dag${dage > 1 ? "e" : ""} ${resterendeTimer} timer`
      : `${dage} dag${dage > 1 ? "e" : ""}`;
  }

  if (timer >= 1) {
    const resterendeMinutter = minutter % 60;
    return `${timer} time${timer > 1 ? "r" : ""} ${resterendeMinutter} min`;
  }

  return `${minutter} min`;
}

export function formatNedtælling(slutterKl: string): string {
  const msTilbage = Math.max(0, new Date(slutterKl).getTime() - Date.now());

  const sekunderTotal = Math.floor(msTilbage / 1000);
  const dage = Math.floor(sekunderTotal / 86400);
  const timer = Math.floor((sekunderTotal % 86400) / 3600);
  const minutter = Math.floor((sekunderTotal % 3600) / 60);
  const sekunder = sekunderTotal % 60;

  const to = (n: number) => n.toString().padStart(2, "0");

  if (dage >= 1) {
    return `${dage}d ${to(timer)}:${to(minutter)}:${to(sekunder)}`;
  }
  return `${to(timer)}:${to(minutter)}:${to(sekunder)}`;
}

export function beregnProcentForløbet(
  oprettet: string,
  slutterKl: string,
): number {
  const start = new Date(oprettet).getTime();
  const slut = new Date(slutterKl).getTime();
  const nu = Date.now();

  if (slut <= start) return 100;

  const procent = ((nu - start) / (slut - start)) * 100;
  return Math.min(100, Math.max(0, Math.round(procent)));
}

// Postgres-interval som tekst (standardformatet "postgres"), fx
// "1 day 23:59:44.77", "3 days", "00:59:44" -> millisekunder.
export function intervalTilMs(interval: string | null | undefined): number {
  if (!interval) return 0;
  let ms = 0;
  const dage = /(-?\d+) days?/.exec(interval);
  if (dage) ms += Number(dage[1]) * 86400000;
  const maaneder = /(-?\d+) mons?/.exec(interval);
  if (maaneder) ms += Number(maaneder[1]) * 30 * 86400000;
  const aar = /(-?\d+) years?/.exec(interval);
  if (aar) ms += Number(aar[1]) * 365 * 86400000;
  const tid = /(-)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(interval);
  if (tid) {
    const t = (Number(tid[2]) * 3600 + Number(tid[3]) * 60 + Number(tid[4])) * 1000;
    ms += tid[1] ? -t : t;
  }
  return Math.max(0, ms);
}

// En auktion er på pause, mens BidHamr har skjult den (kun en aktiv auktion).
export function erPaaPause(a: { status?: string | null; pauset_kl?: string | null }): boolean {
  return a.status === "aktiv" && !!a.pauset_kl;
}

// "På pause – resterende tid 1 dag 23 timer". Genoptages auktionen, får den
// mindst 24 timer (foreslået af Claude, 6. okt. 2026).
export function pauseTekst(resterende: string | null | undefined): string {
  const ms = intervalTilMs(resterende);
  return ms > 0 ? `På pause – resterende tid ${formatVarighed(ms)}` : "På pause";
}
