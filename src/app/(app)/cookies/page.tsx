import type { Metadata } from "next";
import Tekstside from "@/components/Tekstside";
import { COOKIES } from "@/lib/tekster/sider/cookies";

export const metadata: Metadata = {
  title: COOKIES.titel,
  description: COOKIES.metabeskrivelse,
};

export default function CookiesPage() {
  return <Tekstside side={COOKIES} />;
}
