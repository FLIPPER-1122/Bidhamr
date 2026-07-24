"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("redirect") || "/auktioner";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailIkkeBekraeftet, setEmailIkkeBekraeftet] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setEmailIkkeBekraeftet(false);
    setResendSuccess(false);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      if (error.code === "email_not_confirmed" || error.message.toLowerCase().includes("email not confirmed")) {
        setError("Din email er ikke bekræftet endnu. Tjek din indbakke.");
        setEmailIkkeBekraeftet(true);
      } else {
        setError(error.message);
      }
      return;
    }

    router.push(redirectTo);
    router.refresh();
  }

  async function handleResend() {
    if (!email) return;
    setResendLoading(true);
    setResendSuccess(false);

    const supabase = createClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
    });

    setResendLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    setResendSuccess(true);
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-white px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-neutral-200 p-6 sm:p-8">
          <h1 className="text-2xl font-semibold text-neutral-900">
            Log ind
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Velkommen tilbage til BidHamr.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-neutral-900"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-neutral-900"
                >
                  Adgangskode
                </label>
                <Link
                  href="/glemt-adgangskode"
                  className="text-xs font-medium text-brand hover:underline"
                >
                  Glemt adgangskode?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            {emailIkkeBekraeftet && (
              <div>
                {resendSuccess ? (
                  <p className="text-sm text-green-600">
                    Bekræftelsesmail sendt igen – tjek din indbakke.
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resendLoading}
                    className="text-sm font-medium text-brand hover:underline disabled:opacity-50"
                  >
                    {resendLoading ? "Sender…" : "Send bekræftelsesmail igen"}
                  </button>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
            >
              {loading ? "Logger ind…" : "Log ind"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-neutral-500">
          Ny på BidHamr?{" "}
          <Link href="/signup" className="font-medium text-brand">
            Opret konto
          </Link>
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
