import { Nav } from "@/components/nav";
import { ForgotPasswordForm } from "@/components/forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-md px-4 py-12">
        <ForgotPasswordForm />
      </main>
    </>
  );
}
