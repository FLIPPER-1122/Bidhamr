import type { Metadata } from "next";
import Tekstside from "@/components/Tekstside";
import { FAQ_SIDE } from "@/lib/tekster/sider/faq";

export const metadata: Metadata = {
  title: FAQ_SIDE.titel,
  description: FAQ_SIDE.metabeskrivelse,
};

export default function FaqPage() {
  return <Tekstside side={FAQ_SIDE} />;
}
