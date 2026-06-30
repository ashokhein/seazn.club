import { Nav } from "@/components/nav";
import { ResetPasswordForm } from "@/components/reset-password-form";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-md px-4 py-12">
        <ResetPasswordForm token={token ?? null} />
      </main>
    </>
  );
}
