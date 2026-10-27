"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, type ComponentProps } from "react";
import { HENVISNING_PARAM, medHenvisning } from "@/lib/henvisning/kode";

// Henvis en ven uden cookie (Filip, 27. okt. 2026): står der ?ven=KODE i
// adressen på den side, brugeren er på, får links til login, opret konto og
// "Indtast koden" koden med (src/lib/henvisning/kode.ts). Intet gemmes i
// browseren - forlader brugeren siden, er koden væk, medmindre den står i
// næste adresse.
export function useHenvisningskode(): string | null {
  return useSearchParams()?.get(HENVISNING_PARAM) ?? null;
}

type Props = Omit<ComponentProps<typeof Link>, "href"> & { href: string };

function MedKode({ href, ...rest }: Props) {
  const kode = useHenvisningskode();
  return <Link href={medHenvisning(href, kode)} {...rest} />;
}

// Suspense: skulle en side blive forudrenderet (useSearchParams kendes først
// i browseren), vises det almindelige link uden kode imens.
export default function HenvisningLink(props: Props) {
  return (
    <Suspense fallback={<Link {...props} />}>
      <MedKode {...props} />
    </Suspense>
  );
}
