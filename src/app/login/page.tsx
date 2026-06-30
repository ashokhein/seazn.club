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
          <h1 className="text-2xl font-bold tracking-tight text-purple-900">
            S.A.F.E Tournaments
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Organise chess, carrom, cricket and more — across your community.
          </p>
        </div>
        <AuthForm />
      </div>
    </main>
  );
}
