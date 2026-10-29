import { Suspense } from "react";

import { AuthCard } from "@/app/login/_components/AuthCard";
import { LoginForm, NoScriptNote } from "@/components/LoginForm";

export default function LoginPage() {
  return (
    // Without JavaScript the page stops at this card: it says why (fix2-shell review).
    <Suspense
      fallback={
        <AuthCard title="Sign in">
          <NoScriptNote />
        </AuthCard>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
