import { ResetPasswordForm } from "@/components/reset-password-form";
import { NightStage } from "@/components/night-stage";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <NightStage maxW="max-w-md">
      <ResetPasswordForm token={token ?? null} />
    </NightStage>
  );
}
