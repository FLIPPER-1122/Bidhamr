"use client";

import { useRouter } from "next/navigation";
import AdresseFormular from "@/components/konto/AdresseFormular";
import { ADRESSE_TEKST } from "@/lib/adresse/regler";

// Første betaling uden adresse (20261102340000): adressen udfyldes her på
// checkout-siden, og siden hentes igen bagefter, så checkout forudfylder den.
// Serveren afviser også betalingen uden adresse (startBetalingFor,
// kode "adresse_mangler").
export default function CheckoutAdresseKrav({ titel }: { titel: string }) {
  const router = useRouter();
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <h1 className="text-[26px] leading-tight sm:text-[32px]">Betal for {titel}</h1>
      <section
        aria-labelledby="checkout-adresse-titel"
        className="mt-6 rounded-none border border-kant bg-white p-5 shadow-kort sm:p-6"
      >
        <h2 id="checkout-adresse-titel" className="text-[20px] leading-tight lg:text-[22px]">
          {ADRESSE_TEKST.kraevesTitel}
        </h2>
        <p className="mt-1 text-sm text-tekst-daempet">{ADRESSE_TEKST.kraevesBetaling}</p>
        <div className="mt-4">
          <AdresseFormular
            idPrefix="betal-adr-"
            autoFokus
            knapTekst={ADRESSE_TEKST.gemOgFortsaet}
            onGemt={() => router.refresh()}
          />
        </div>
      </section>
    </main>
  );
}
