import type { Metadata } from "next";
import Tekstside from "@/components/Tekstside";
import { SAADAN_VIRKER_DET } from "@/lib/tekster/sider/saadanVirkerDet";

export const metadata: Metadata = {
  title: SAADAN_VIRKER_DET.titel,
  description: SAADAN_VIRKER_DET.metabeskrivelse,
};

export default function SaadanVirkerDetPage() {
  return <Tekstside side={SAADAN_VIRKER_DET} />;
}
