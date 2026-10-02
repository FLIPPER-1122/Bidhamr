// PostgREST bruger komma og parenteser som syntaks i .or(), så værdien
// citeres og indlejrede citationstegn/backslashes escapes. Returnerer et
// ilike-mønster ("%tekst%"), fx `navn.ilike.${orVaerdi(q)}`.
export function orVaerdi(tekst: string) {
  return `"%${tekst.replace(/["\\]/g, "\\$&")}%"`;
}
