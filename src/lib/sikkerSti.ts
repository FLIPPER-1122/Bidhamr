// Beskytter mod aaben omdirigering: kun relative stier paa vores eget domaene.
export function sikkerSti(sti: string | null | undefined, fallback = "/"): string {
  if (!sti) return fallback;
  if (!sti.startsWith("/")) return fallback;
  if (sti.startsWith("//") || sti.startsWith("/\\")) return fallback;
  if (sti.includes("://")) return fallback;
  // Backslash og kontroltegn (fx tab/linjeskift) kan snyde browserens URL-parser.
  if (/[\u0000-\u001f\u007f\\]/.test(sti)) return fallback;
  return sti;
}
