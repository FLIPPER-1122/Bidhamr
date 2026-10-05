import type { Metadata } from "next";
import Tekstside from "@/components/Tekstside";
import { OM } from "@/lib/tekster/sider/om";

export const metadata: Metadata = {
  title: OM.titel,
  description: OM.metabeskrivelse,
};

export default function OmPage() {
  return <Tekstside side={OM} />;
}
