import { VerifyEmail } from "@/components/verify-email";
import { NightStage } from "@/components/night-stage";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const { token, next } = await searchParams;
  return (
    <NightStage maxW="max-w-md">
      <VerifyEmail token={token ?? null} next={next ?? null} />
    </NightStage>
  );
}
