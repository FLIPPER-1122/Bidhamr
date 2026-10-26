// Rene regler for den lukkede "før lancering"-udgave (src/lib/lukketUdgave.ts).
// Samme roller som ROLLER_MED_ADGANG i src/lib/supabase/middleware.ts.
const ROLLER_MED_ADGANG = ["chef", "admin", "medarbejder", "saelger"];

export function harAdgangTilLukketApp(id: { rolle: string | null; kontoType: string | null; beta: boolean }): boolean {
  if (id.rolle && ROLLER_MED_ADGANG.includes(id.rolle)) return true;
  if (id.kontoType === "erhverv") return true;
  return id.beta;
}

// Sider, der må linkes til i den lukkede udgave (resten sender til
// /coming-soon). Bruges til at skjule krydslinks på de juridiske sider.
const LUKKET_TILLADTE = ["/coming-soon", "/erhverv", "/privatliv", "/betingelser", "/dsa"];

export function linkTilladtILukketUdgave(href: string): boolean {
  if (/^(mailto:|tel:|#)/.test(href)) return true;
  const sti = href.split(/[?#]/)[0];
  return LUKKET_TILLADTE.some((r) => sti === r || sti.startsWith(`${r}/`));
}
