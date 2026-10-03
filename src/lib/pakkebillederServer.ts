import "server-only";

// Henter pakkebillederne for en handel med signerede links (1 time).
// Med brugerens egen session afgør RLS/storage-policyerne adgangen (køber og
// sælger på handlen); staff kalder med createAdminClient(). Kaster aldrig -
// billederne er ekstra information, så en fejl giver en tom liste.
import type { SupabaseClient } from "@supabase/supabase-js";
import { PAKKE_BUCKET, type PakkeBilledeKategori, erPakkeBilledeKategori } from "@/lib/pakkebilleder";

export type VistPakkeBillede = {
  id: string;
  kategori: PakkeBilledeKategori;
  url: string | null;
  oprettetKl: string;
};

export async function hentPakkeBilleder(
  klient: SupabaseClient,
  tradeId: string,
): Promise<VistPakkeBillede[]> {
  try {
    const { data, error } = await klient
      .from("pakke_billeder")
      .select("id, sti, kategori, oprettet_kl")
      .eq("trade_id", tradeId)
      .order("oprettet_kl", { ascending: true })
      .limit(20);
    if (error) {
      console.error("Hentning af pakkebilleder fejlede:", tradeId, error.message);
      return [];
    }
    const raekker = ((data ?? []) as { id: string; sti: string; kategori: string; oprettet_kl: string }[])
      .filter((r) => erPakkeBilledeKategori(r.kategori));
    if (raekker.length === 0) return [];

    const urls = new Map<string, string>();
    const { data: signerede } = await klient.storage
      .from(PAKKE_BUCKET)
      .createSignedUrls(raekker.map((r) => r.sti), 3600);
    for (const s of signerede ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);

    return raekker.map((r) => ({
      id: r.id,
      kategori: r.kategori as PakkeBilledeKategori,
      url: urls.get(r.sti) ?? null,
      oprettetKl: r.oprettet_kl,
    }));
  } catch (err) {
    console.error("Hentning af pakkebilleder fejlede:", tradeId, err);
    return [];
  }
}
