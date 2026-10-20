import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auktionJsonLd, auktionSynlig } from "@/lib/auktionSeo";
import { staffRolleTilVisning } from "@/lib/adminAuth";
import { adminUrl } from "@/lib/adminVaert";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!synlig) {
    // Staff ser skjulte, arkiverede og kunst-afventende auktioner kun med
    // to-trins-login (migration B, 20261027020000) - dvs. i admin. På
    // hovedsitet (aal1) sendes de til admins visning af auktionen i stedet for
    // en 404. Rollen er fra databasen (min_rolle); admin-siden tjekker selv
    // adgangen igen. 'saelger' (Erhverv) er ikke med.
    const rolle = await staffRolleTilVisning();
    if ((rolle === "medarbejder" || rolle === "admin" || rolle === "chef") && UUID.test(id)) {
      const { data: findes } = await createAdminClient()
        .from("auctions")
        .select("id")
        .eq("id", id)
        .maybeSingle<{ id: string }>();
      if (findes) redirect(adminUrl(`/admin/auktioner/${id}`));
    }
    notFound();
  }
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
