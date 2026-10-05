import "server-only";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { kortBeskrivelse, seoIndeksering, sideUrl } from "@/lib/seo";
import { standNavn } from "@/lib/stand";

// SEO for /auktion/[id]: metadata (generateMetadata i page.tsx) og JSON-LD
// (layout.tsx). Hentes med brugerens egen klient (RLS), og én gang pr.
// forespørgsel takket være cache().

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AuktionSeo = {
  id: string;
  titel: string;
  beskrivelse: string | null;
  billeder: string[];
  pris: number;
  slutterKl: string;
  aktiv: boolean;
  arkiveret: boolean;
  stand: string | null;
  kategori: string | null;
};

export const hentAuktionSeo = cache(async (id: string): Promise<AuktionSeo | null> => {
  if (!UUID.test(id)) return null;
  try {
    const supabase = await createClient();
    // "*": supabase-js kan ikke parse "nuværende_bud" i en select-streng.
    const { data } = await supabase.from("auctions").select("*").eq("id", id).maybeSingle();
    if (!data || data.skjult) return null;
    const billeder = Array.isArray(data.billeder)
      ? (data.billeder as unknown[]).filter((b): b is string => typeof b === "string" && /^https:\/\//.test(b))
      : [];
    return {
      id: data.id,
      titel: String(data.titel ?? ""),
      beskrivelse: (data.beskrivelse as string | null) ?? null,
      billeder,
      pris: Number(data.nuværende_bud ?? data.startpris ?? 0),
      slutterKl: data.slutter_kl,
      aktiv: data.status === "aktiv" && new Date(data.slutter_kl) > new Date(),
      arkiveret: data.arkiveret_kl != null,
      stand: (data.stand as string | null) ?? null,
      kategori: (data.kategori as string | null) ?? null,
    };
  } catch {
    return null;
  }
});

const kr = (n: number) => `${n.toLocaleString("da-DK", { maximumFractionDigits: 2 })} kr.`;
const dato = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });

export async function auktionMetadata(id: string): Promise<Metadata> {
  const a = await hentAuktionSeo(id);
  if (!a) {
    return { title: "Auktionen findes ikke", robots: { index: false, follow: false } };
  }

  const status = a.aktiv
    ? `Nuværende bud ${kr(a.pris)} · slutter ${dato(a.slutterKl)}.`
    : `Auktionen er slut. Slutpris ${kr(a.pris)}.`;
  const description = kortBeskrivelse(`${status} ${a.beskrivelse ?? ""}`);
  const canonical = `/auktion/${a.id}`;

  return {
    title: a.titel,
    description,
    alternates: { canonical },
    // Arkiverede auktioner skal ikke i søgeresultaterne.
    ...(a.arkiveret ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: "website",
      url: canonical,
      title: `${a.titel} · BidHamr`,
      description,
      ...(a.billeder[0] ? { images: [{ url: a.billeder[0], alt: a.titel }] } : {}),
    },
    twitter: {
      card: a.billeder[0] ? "summary_large_image" : "summary",
      title: `${a.titel} · BidHamr`,
      description,
      ...(a.billeder[0] ? { images: [a.billeder[0]] } : {}),
    },
  };
}

// schema.org-stand (https://schema.org/OfferItemCondition).
function itemCondition(stand: string | null): string | undefined {
  switch (stand) {
    case "ny_med_maerke":
      return "https://schema.org/NewCondition";
    case "som_ny":
    case "god":
    case "brugt":
      return "https://schema.org/UsedCondition";
    case "defekt":
      return "https://schema.org/DamagedCondition";
    default:
      return undefined;
  }
}

// JSON-LD (Product + Offer). Kun offentlige felter, ingen sælgeroplysninger.
// Kun når siden må indekseres, og auktionen ikke er arkiveret.
export async function auktionJsonLd(id: string): Promise<string | null> {
  if (!seoIndeksering()) return null;
  const a = await hentAuktionSeo(id);
  if (!a || a.arkiveret) return null;
  const url = `${sideUrl()}/auktion/${a.id}`;
  const condition = itemCondition(a.stand);
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: a.titel,
    description: kortBeskrivelse(a.beskrivelse, 5000) || a.titel,
    ...(a.billeder.length ? { image: a.billeder.slice(0, 10) } : {}),
    ...(a.kategori ? { category: a.kategori } : {}),
    sku: a.id.slice(-6).toUpperCase(),
    ...(a.stand ? { additionalProperty: { "@type": "PropertyValue", name: "Stand", value: standNavn(a.stand) } } : {}),
    offers: {
      "@type": "Offer",
      url,
      price: a.pris,
      priceCurrency: "DKK",
      priceValidUntil: a.slutterKl.slice(0, 10),
      availability: a.aktiv ? "https://schema.org/InStock" : "https://schema.org/SoldOut",
      ...(condition ? { itemCondition: condition } : {}),
    },
  };
  // "<" escapes, så tekst fra brugeren aldrig kan lukke script-tagget.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
