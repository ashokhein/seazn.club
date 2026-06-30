import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo-wide.png"
            alt="Seazn Club"
            className="mx-auto mb-4 h-12 w-auto"
          />
          <p className="text-sm text-slate-500">
            Organise chess, carrom, cricket and more — across your community.
          </p>
        </div>
        <AuthForm />
      </div>
    </main>
  );
}
