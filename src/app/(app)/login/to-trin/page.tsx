import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { manglerToTrin } from "@/lib/mfa";
import { sikkerSti } from "@/lib/sikkerSti";
import ToTrinForm from "./ToTrinForm";

// Trin 2 af login for brugere med to-trins-login. Proxyen sender hertil,
// så længe sessionen kun har adgangskoden (aal1).
export const metadata: Metadata = { title: "Indtast kode", robots: { index: false, follow: false } };

export default async function ToTrinSide({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect: maalInput } = await searchParams;
  const maal = sikkerSti(maalInput ?? null, "/auktioner");

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(`/login?redirect=${encodeURIComponent(maal)}`);
  if (!(await manglerToTrin(supabase, data.user))) redirect(maal);

  return <ToTrinForm maal={maal} />;
}
