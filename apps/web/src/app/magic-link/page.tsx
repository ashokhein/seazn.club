import { MagicLink } from "@/components/magic-link";
import { NightStage } from "@/components/night-stage";

export default async function MagicLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const { token, next } = await searchParams;
  return (
    <NightStage maxW="max-w-md">
      <MagicLink token={token ?? null} next={next ?? null} />
    </NightStage>
  );
}
