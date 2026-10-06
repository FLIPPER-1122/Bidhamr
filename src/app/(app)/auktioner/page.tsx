import AuctionsExplorer from "@/components/AuctionsExplorer";
import { læsSortering } from "@/lib/sortering";
import { createClient } from "@/lib/supabase/server";
import { RADIUS_MAX_KM, hentAuktionsside } from "@/lib/auktionSoegning";
import { slaaPostnummerOp } from "@/lib/postnumre";
import type { Metadata } from "next";
import { kategorier } from "@/lib/kategorier";

// Kategorisider er egne sider i søgemaskinerne; fritekstsøgninger indekseres
// ikke (uendeligt mange varianter af samme indhold).
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kategori?: string }>;
}): Promise<Metadata> {
  const { q, kategori } = await searchParams;
  const søg = q?.trim() ?? "";
  const kat = kategorier.find((k) => k === kategori?.trim());
  if (søg) {
    return {
      title: `Søgning: ${søg.slice(0, 60)}`,
      robots: { index: false, follow: true },
      alternates: { canonical: "/auktioner" },
    };
  }
  if (kat) {
    return {
      title: `${kat} på auktion`,
      description: `Byd på brugt ${kat.toLowerCase()} fra private sælgere i hele Danmark. Trygt med BidHamr Beskyttelse.`,
      alternates: { canonical: `/auktioner?kategori=${encodeURIComponent(kat)}` },
    };
  }
  return {
    title: "Alle auktioner",
    description:
      "Se alle auktioner på BidHamr lige nu. Find brugte ting fra private sælgere, og byd trygt med BidHamr Beskyttelse.",
    alternates: { canonical: "/auktioner" },
  };
}

export default async function AuktionerPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    kategori?: string;
    sortering?: string;
    postnummer?: string;
    afstand?: string;
  }>;
}) {
  const { q, kategori, sortering, postnummer, afstand } = await searchParams;
  const søgetekst = q?.trim() ?? "";
  // Kun kendte kategorier – ukendte værdier ignoreres (som i generateMetadata).
  const initialKategori = kategorier.find((k) => k === kategori?.trim()) ?? "";
  // ?sortering= fra forsiden og menuen ("Slutter snart", "Nye auktioner").
  const initialSortering = læsSortering(sortering);
  // ?postnummer=&afstand= fra en gemt søgning. Ugyldige værdier ignoreres.
  const initialPostnummer = /^\d{4}$/.test(postnummer ?? "") ? postnummer! : "";
  const afstandKm = Number(afstand);
  const initialRadiusKm =
    initialPostnummer && Number.isInteger(afstandKm) && afstandKm >= 5 && afstandKm <= 150
      ? Math.round(afstandKm / 5) * 5
      : undefined;

  // Samme standard som filterbjælken (50 km), når kun postnummeret er givet.
  const radiusKm = initialRadiusKm ?? 50;
  const initialAfstandAktiv = Boolean(slaaPostnummerOp(initialPostnummer)) && radiusKm < RADIUS_MAX_KM;

  const [{ data: authData }, side] = await Promise.all([
    (await createClient()).auth.getUser(),
    hentAuktionsside({
      q: søgetekst,
      kategori: initialKategori,
      sortering: initialSortering,
      postnummer: initialPostnummer,
      radiusKm,
    }),
  ]);

  // Vises af error.tsx - en tom liste ville fejlagtigt sige "ingen auktioner".
  if (!side.ok) throw new Error("Auktionerne kunne ikke hentes");

  return (
    <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <h1 className="text-[26px] leading-tight break-words sm:text-[32px]">
        {søgetekst ? `Søgeresultater for "${søgetekst}"` : "Alle auktioner"}
      </h1>

      <AuctionsExplorer
        initialAuktioner={side.auktioner}
        initialTotal={side.total}
        initialTotalType={side.totalType}
        initialQuery={søgetekst}
        initialKategori={initialKategori}
        initialSortering={initialSortering}
        initialPostnummer={initialPostnummer}
        initialRadiusKm={initialRadiusKm}
        initialAfstandAktiv={initialAfstandAktiv}
        erLoggetInd={Boolean(authData.user)}
      />
    </main>
  );
}
