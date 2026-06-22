export function anonymUsername(brugerId: string): string {
  const hex = brugerId.replace(/-/g, "").slice(0, 8);
  const nummer = parseInt(hex, 16) % 10000;
  return `Bruger #${nummer.toString().padStart(4, "0")}`;
}
