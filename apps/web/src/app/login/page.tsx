import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";
import { NightStage } from "@/components/night-stage";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");

  return (
    <NightStage>
      <p className="-mt-3 mb-6 text-center text-sm text-cream/70">
        Organise chess, carrom, cricket and more — across your community.
      </p>
      <AuthForm />
    </NightStage>
  );
}
