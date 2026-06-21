import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LogoutButton from "@/components/LogoutButton";

export default async function OpretAuktionPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  return (
    <main className="flex min-h-screen flex-col items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Opret auktion</h1>
          <LogoutButton />
        </div>
        <p className="mt-4 text-sm text-neutral-600">
          Formularen til at oprette en auktion kommer her.
        </p>
      </div>
    </main>
  );
}
