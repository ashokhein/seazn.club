import { Nav } from "@/components/nav";
import { MagicLink } from "@/components/magic-link";

export default async function MagicLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const { token, next } = await searchParams;
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-md px-4 py-12">
        <MagicLink token={token ?? null} next={next ?? null} />
      </main>
    </>
  );
}
