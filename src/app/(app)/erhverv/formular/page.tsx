import type { Metadata } from "next";
import Link from "next/link";
import ErhvervFormular from "@/components/erhverv/ErhvervFormular";
import { ERHVERV_SIDE_EKSTRA } from "@/lib/tekster/erhverv";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";
import { robotsFoerLancering } from "@/lib/seo";

// Erhvervsformularen. Offentlig (også før lancering og uden login). Sendes
// via /api/offentlig/erhverv-henvendelse -> sendErhvervHenvendelse.
export const metadata: Metadata = {
  title: ERHVERV_SIDE_EKSTRA.formularMetaTitel,
  alternates: { canonical: "/erhverv/formular" },
  // Formularen indekseres ikke (følg links dog) - /erhverv er siden i Google.
  ...robotsFoerLancering(null),
};

export default function ErhvervFormularSide() {
  return (
    <main className="flex-1 bg-white">
      <div className="mx-auto max-w-[720px] px-4 py-8 sm:px-6 sm:py-12">
        <Link
          href="/erhverv"
          className="inline-flex min-h-12 items-center rounded-md text-[17px] font-medium text-groen underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          ← {ERHVERV_SIDE_EKSTRA.formularTilbage}
        </Link>
        {/* Overskrift og intro ligger i ErhvervFormular, så de forsvinder, når formularen er sendt. */}
        <div className="mt-2">
          <ErhvervFormular />
        </div>

        <p className="mt-8 text-[17px] text-tekst">
          {ERHVERV_SIDE_EKSTRA.kontaktLinje}{" "}
          <a href={`mailto:${ERHVERV_EMAIL}`} className="font-semibold text-groen underline underline-offset-2">
            {ERHVERV_EMAIL}
          </a>
          .
        </p>
      </div>
    </main>
  );
}
