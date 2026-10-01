// Fælles miljø-tjek. Fail closed: kun præcis testdatabasens host giver true.
// Manglende/ugyldig URL, produktions-ref eller alt andet giver false.
const TEST_HOST = "pjiigmzqwlfepxnjdvug.supabase.co";

export function erTestdatabase(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.host === TEST_HOST;
  } catch {
    return false;
  }
}
