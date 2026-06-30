import { Nav } from "@/components/nav";
import { VerifyEmail } from "@/components/verify-email";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const { token, next } = await searchParams;
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-md px-4 py-12">
        <VerifyEmail token={token ?? null} next={next ?? null} />
      </main>
    </>
  );
}
