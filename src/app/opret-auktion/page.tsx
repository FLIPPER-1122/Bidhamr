import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import OpretAuktionForm from "@/components/OpretAuktionForm";

export default async function OpretAuktionPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) {
    redirect("/login");
  }

  return (
    <main className="flex flex-1 justify-center bg-white px-4 py-10">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold text-neutral-900">
          Opret auktion
        </h1>

        <div className="mt-6">
          <OpretAuktionForm brugerId={data.user.id} />
        </div>
      </div>
    </main>
  );
}
