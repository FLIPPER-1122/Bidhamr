export function kortNavn(navn: string | null | undefined): string {
  if (!navn?.trim()) return "Anonym";
  const dele = navn.trim().split(/\s+/);
  if (dele.length === 1) return dele[0];
  return `${dele[0]} ${dele[1][0].toUpperCase()}.`;
}
