import { LoginForm } from "@/components/auth/login-form";

export default function LoginPage({
  searchParams
}: {
  searchParams?: { next?: string; error?: string };
}) {
  return (
    <main className="auth-page-shell">
      <LoginForm nextPath={searchParams?.next} errorCode={searchParams?.error} />
    </main>
  );
}
