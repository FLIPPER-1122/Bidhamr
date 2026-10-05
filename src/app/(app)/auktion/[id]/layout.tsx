import { headers } from "next/headers";
import { auktionJsonLd } from "@/lib/auktionSeo";

// Strukturerede data (JSON-LD Product/Offer) til søgemaskiner. Ligger i et
// layout, så selve auktionssiden ikke skal ændres. Data hentes én gang pr.
// forespørgsel sammen med generateMetadata (cache() i src/lib/auktionSeo.ts).
export default async function AuktionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [jsonLd, h] = await Promise.all([auktionJsonLd(id), headers()]);
  const nonce = h.get("x-nonce") ?? undefined;

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: jsonLd }}
        />
      )}
      {children}
    </>
  );
}
