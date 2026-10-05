import { Suspense } from "react";
import { tilmeldingAaben } from "@/lib/tilmelding";
import LoginForm from "./LoginForm";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm tilmeldingAaben={tilmeldingAaben()} />
    </Suspense>
  );
}
