import "server-only";

// Henter en brugers modtagne bedømmelser med sælgerens svar til profilen.
// Bruger brugerens egen klient, så RLS afgør synligheden: skjulte
// bedømmelser og skjulte/slettede svar kommer aldrig med (sælgeren ser dog
// sit eget skjulte svar, markeret skjult).
import type { createClient } from "@/lib/supabase/server";
import { kortNavn } from "@/lib/kortNavn";
import { svarKanRettes, type BedoemmelseVisning } from "@/lib/bedoemmelser";

type Klient = Awaited<ReturnType<typeof createClient>>;

export async function hentBedoemmelser(
  supabase: Klient,
  tilBrugerId: string,
): Promise<BedoemmelseVisning[]> {
  const { data: ratings, error } = await supabase
    .from("ratings")
    .select("id, fra_bruger_id, stjerner, kommentar, oprettet")
    .eq("til_bruger_id", tilBrugerId)
    .eq("skjult", false)
    .order("oprettet", { ascending: false })
    .limit(200);
  if (error) console.error("Bedømmelser kunne ikke hentes:", error.message);
  const liste = ratings ?? [];
  if (liste.length === 0) return [];

  const ids = liste.map((r) => r.id as string);
  const fraIds = [...new Set(liste.map((r) => r.fra_bruger_id as string))];
  const [{ data: navne }, { data: svar, error: svarFejl }] = await Promise.all([
    supabase.from("users").select("id, navn").in("id", fraIds),
    supabase
      .from("bedoemmelse_svar")
      .select("rating_id, tekst, oprettet, rettet_kl, skjult")
      .in("rating_id", ids),
  ]);
  // 42P01: migrationen er ikke kørt endnu - så vises bedømmelserne uden svar.
  if (svarFejl && svarFejl.code !== "42P01") {
    console.error("Svar på bedømmelser kunne ikke hentes:", svarFejl.message);
  }

  const nu = Date.now();
  const navnMap = new Map((navne ?? []).map((u) => [u.id as string, u.navn as string | null]));
  const svarMap = new Map(
    (svar ?? []).map((s) => [
      s.rating_id as string,
      {
        tekst: s.tekst as string,
        oprettet: s.oprettet as string,
        rettet_kl: (s.rettet_kl as string | null) ?? null,
        skjult: s.skjult === true,
        kanRettes: svarKanRettes(s.oprettet as string, nu),
      },
    ]),
  );

  return liste.map((r) => ({
    id: r.id as string,
    fra_bruger_id: r.fra_bruger_id as string,
    fra_bruger_navn: kortNavn(navnMap.get(r.fra_bruger_id as string)),
    stjerner: Number(r.stjerner),
    kommentar: (r.kommentar as string | null) ?? null,
    oprettet: r.oprettet as string,
    svar: svarMap.get(r.id as string) ?? null,
  }));
}
