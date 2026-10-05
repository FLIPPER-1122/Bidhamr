import type { Metadata } from "next";
import SideFindesIkke from "@/components/fejl/SideFindesIkke";

// Rod-404: adresser, der ikke matcher nogen side. Vises uden topbar og footer
// (rodlayoutet har dem ikke), derfor med logo. 404 inde i appen (fx en
// auktion, der ikke findes) bruger src/app/(app)/not-found.tsx.
export const metadata: Metadata = {
  title: "Siden findes ikke",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return <SideFindesIkke medLogo />;
}
