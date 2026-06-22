export function formatTidTilbage(slutterKl: string): string {
  const msTilbage = new Date(slutterKl).getTime() - Date.now();

  if (msTilbage <= 0) return "Afsluttet";

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
