import type { Metadata } from "next";
import Tekstside from "@/components/Tekstside";
import { TILGAENGELIGHED } from "@/lib/tekster/sider/tilgaengelighed";

export const metadata: Metadata = {
  title: TILGAENGELIGHED.titel,
  description: TILGAENGELIGHED.metabeskrivelse,
};

export default function TilgaengelighedPage() {
  return <Tekstside side={TILGAENGELIGHED} />;
}
