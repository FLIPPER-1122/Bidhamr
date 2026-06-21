import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LogoutButton from "@/components/LogoutButton";

export default async function ProfilPage() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("users")
    .select("navn, email, telefon, rating")
    .eq("id", authData.user.id)
    .single();

  return (
    <main className="flex flex-1 items-center justify-center bg-white px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-neutral-200 p-6 sm:p-8">
          <h1 className="text-2xl font-semibold text-neutral-900">
            Min profil
          </h1>

          <div className="mt-6 space-y-3 text-sm text-neutral-900">
            <p>
              <span className="font-medium">Navn:</span> {profile?.navn}
            </p>
            <p>
              <span className="font-medium">Email:</span> {profile?.email}
            </p>
            <p>
              <span className="font-medium">Telefon:</span>{" "}
              {profile?.telefon || "—"}
            </p>
            <p>
              <span className="font-medium">Rating:</span>{" "}
              {profile?.rating ?? 0} ⭐
            </p>
          </div>

          <div className="mt-8">
            <LogoutButton />
          </div>
        </div>
      </div>
    </main>
  );
}
