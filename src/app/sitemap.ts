import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { kategorier } from "@/lib/kategorier";
import { seoIndeksering, sideUrl, TEKSTSIDER } from "@/lib/seo";

// sitemap.xml: forside, alle auktioner, kategorier, aktive auktioner og
// tekstsiderne. Tom, indtil SEO_INDEKSERING=true (se src/lib/seo.ts), så
// pre-launch ikke afslører auktioner for søgemaskiner.
const MAKS_AUKTIONER = 5000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  if (!seoIndeksering()) return [];

  const base = sideUrl();
  const nu = new Date();

  const faste: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: nu, changeFrequency: "hourly", priority: 1 },
    { url: `${base}/auktioner`, lastModified: nu, changeFrequency: "hourly", priority: 0.9 },
    ...kategorier.map((k) => ({
      url: `${base}/auktioner?kategori=${encodeURIComponent(k)}`,
      lastModified: nu,
      changeFrequency: "hourly" as const,
      priority: 0.7,
    })),
    ...TEKSTSIDER.map((sti) => ({
      url: `${base}${sti}`,
      changeFrequency: "monthly" as const,
      priority: 0.4,
    })),
  ];

  // Kun offentlige, aktive auktioner: ikke skjulte (moderation), ikke
  // arkiverede, ikke udløbne. Service-role, da sitemap'et ikke har en bruger;
  // filtrene her er det eneste, der bestemmer, hvad der kommer med.
  let auktioner: MetadataRoute.Sitemap = [];
  try {
    const { data, error } = await createAdminClient()
      .from("auctions")
      .select("id, oprettet")
      .eq("status", "aktiv")
      .eq("skjult", false)
      .is("arkiveret_kl", null)
      .gt("slutter_kl", nu.toISOString())
      .order("slutter_kl", { ascending: true })
      .limit(MAKS_AUKTIONER)
      .overrideTypes<{ id: string; oprettet: string }[], { merge: false }>();
    if (error) {
      console.error("[sitemap] auktioner kunne ikke hentes:", error.message);
    } else {
      auktioner = (data ?? []).map((a) => ({
        url: `${base}/auktion/${a.id}`,
        lastModified: a.oprettet ? new Date(a.oprettet) : undefined,
        changeFrequency: "hourly" as const,
        priority: 0.8,
      }));
    }
  } catch (err) {
    console.error("[sitemap] auktioner kunne ikke hentes:", err);
  }

  return [...faste, ...auktioner];
}
