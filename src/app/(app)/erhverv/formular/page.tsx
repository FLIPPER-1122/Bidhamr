import type { Metadata } from "next";
import Link from "next/link";
import ErhvervFormular from "@/components/erhverv/ErhvervFormular";
import { ERHVERV_FORMULAR, ERHVERV_SIDE_EKSTRA } from "@/lib/tekster/erhverv";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";

// Erhvervsformularen. Offentlig (også før lancering og uden login). Sendes
// via /api/offentlig/erhverv-henvendelse -> sendErhvervHenvendelse.
export const metadata: Metadata = {
  title: ERHVERV_SIDE_EKSTRA.formularMetaTitel,
  alternates: { canonical: "/erhverv/formular" },
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
        <h1 className="mt-2 text-[30px] leading-tight sm:text-[36px]">{ERHVERV_FORMULAR.titel}</h1>
        <p className="mt-3 text-[18px] leading-relaxed text-tekst-daempet">{ERHVERV_FORMULAR.intro}</p>

        <div className="mt-8">
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
