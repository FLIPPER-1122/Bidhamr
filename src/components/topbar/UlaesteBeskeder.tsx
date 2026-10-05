"use client";

// Ét fælles tal for ulæste beskeder fra BidHamr i hele topbaren, så
// beskedikonet, konto-menuen og mobilmenuen ikke hver især spørger serveren.
import { createContext, useContext } from "react";
import { useUlaesteBeskeder } from "@/components/staffchat/useUlaesteBeskeder";

const Kontekst = createContext(0);

export function UlaesteBeskederProvider({
  startAntal,
  aktiv,
  children,
}: {
  startAntal: number;
  aktiv: boolean;
  children: React.ReactNode;
}) {
  const antal = useUlaesteBeskeder(startAntal, aktiv);
  return <Kontekst.Provider value={antal}>{children}</Kontekst.Provider>;
}

export function useAntalUlaesteBeskeder() {
  return useContext(Kontekst);
}

export function beskederTekst(antal: number) {
  return antal === 1 ? "1 ulæst besked fra BidHamr" : `${antal} ulæste beskeder fra BidHamr`;
}
