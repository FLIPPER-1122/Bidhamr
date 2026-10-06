import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auktionJsonLd, auktionSynlig } from "@/lib/auktionSeo";

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
  const [synlig, jsonLd, h] = await Promise.all([auktionSynlig(id), auktionJsonLd(id), headers()]);
  // Tjekkes her og ikke kun i page.tsx: layoutet ligger uden for
  // loading.tsx-grænsen, så notFound() giver en rigtig 404-status, før
  // skelettet streames.
  if (!synlig) notFound();
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
