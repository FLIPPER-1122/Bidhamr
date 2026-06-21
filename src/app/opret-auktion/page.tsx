import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function OpretAuktionPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-white px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-neutral-200 p-6 sm:p-8">
          <h1 className="text-2xl font-semibold text-neutral-900">
            Opret auktion
          </h1>
          <p className="mt-4 text-sm text-neutral-500">
            Formularen til at oprette en auktion kommer her.
          </p>
        </div>
      </div>
    </main>
  );
}
