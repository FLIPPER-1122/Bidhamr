// PostgREST bruger komma og parenteser som syntaks i .or(), så værdien
// citeres og indlejrede citationstegn/backslashes escapes. Returnerer et
// ilike-mønster ("%tekst%"), fx `navn.ilike.${orVaerdi(q)}`.
export function orVaerdi(tekst: string) {
  return `"%${tekst.replace(/["\\]/g, "\\$&")}%"`;
}

// Escaper tegnene med særlig betydning i et LIKE-mønster (\ % _), så de
// søges som almindelige tegn (Postgres' escapetegn er backslash). Bemærk:
// PostgREST gør "*" til "%" i like/ilike, og det kan ikke escapes - brug
// escapeRegex med imatch, hvis teksten indeholder "*".
export function escapeLike(tekst: string): string {
  return tekst.replace(/[\\%_]/g, "\\$&");
}

// Escaper alle regex-tegn, så teksten kun matcher sig selv (til imatch/~*).
export function escapeRegex(tekst: string): string {
  return tekst.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
