import "server-only";

// Henter en brugers modtagne bedømmelser med sælgerens svar til profilen.
// Bruger brugerens egen klient, så RLS afgør synligheden: skjulte
// bedømmelser og skjulte/slettede svar kommer aldrig med (sælgeren ser dog
// sit eget skjulte svar, markeret skjult).
import type { createClient } from "@/lib/supabase/server";
import { kortNavn } from "@/lib/kortNavn";
import { svarKanRettes, type BedoemmelseVisning } from "@/lib/bedoemmelser";

type Klient = Awaited<ReturnType<typeof createClient>>;

// Gennemsnit og antal til profilhovedet. Regnes IKKE ud fra listen (den er
// begrænset til de nyeste 200): users.rating vedligeholdes af en trigger
// (synlige bedømmelser), og antallet tælles i databasen.
export async function hentBedoemmelseOpsummering(
  supabase: Klient,
  tilBrugerId: string,
): Promise<{ gennemsnit: number; antal: number }> {
  const [{ data: bruger, error: brugerFejl }, { count, error: antalFejl }] = await Promise.all([
    supabase.from("users").select("rating").eq("id", tilBrugerId).maybeSingle(),
    supabase
      .from("ratings")
      .select("id", { count: "exact", head: true })
      .eq("til_bruger_id", tilBrugerId)
      .eq("skjult", false),
  ]);
  if (brugerFejl) console.error("Gennemsnit kunne ikke hentes:", brugerFejl.message);
  if (antalFejl) console.error("Antal bedømmelser kunne ikke hentes:", antalFejl.message);
  const antal = count ?? 0;
  const gennemsnit = Number(bruger?.rating ?? 0);
  return { antal, gennemsnit: antal > 0 && Number.isFinite(gennemsnit) ? gennemsnit : 0 };
}

// erEjer: profilens ejer ser sin egen liste - så hentes også, hvilke svar
// han selv har slettet (RLS skjuler dem), så han ikke tilbydes at svare igen.
export async function hentBedoemmelser(
  supabase: Klient,
  tilBrugerId: string,
  { erEjer = false }: { erEjer?: boolean } = {},
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
  const [{ data: navne }, { data: svar, error: svarFejl }, slettede] = await Promise.all([
    supabase.from("users").select("id, navn").in("id", fraIds),
    supabase
      .from("bedoemmelse_svar")
      .select("rating_id, tekst, oprettet, rettet_kl, skjult")
      .in("rating_id", ids),
    erEjer
      ? supabase.rpc("mine_slettede_bedoemmelse_svar").then(({ data, error: e }) => {
          // 42883: migrationen 20261007021000 er ikke kørt endnu.
          if (e && e.code !== "42883" && e.code !== "PGRST202") {
            console.error("Slettede svar kunne ikke hentes:", e.message);
          }
          return new Set(((data ?? []) as { rating_id: string }[]).map((x) => x.rating_id));
        })
      : Promise.resolve(new Set<string>()),
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
    svarSlettet: slettede.has(r.id as string),
    svar: svarMap.get(r.id as string) ?? null,
  }));
}
