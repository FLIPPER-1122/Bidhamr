import type { Metadata } from "next";
import Tekstside from "@/components/Tekstside";
import { PAKKEGUIDE } from "@/lib/tekster/sider/pakkeguide";

export const metadata: Metadata = {
  title: PAKKEGUIDE.titel,
  description: PAKKEGUIDE.metabeskrivelse,
};

export default function PakkeguidePage() {
  return <Tekstside side={PAKKEGUIDE} />;
}
