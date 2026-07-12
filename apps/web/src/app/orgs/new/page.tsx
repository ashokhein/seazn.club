export const dynamic = "force-dynamic";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getUserOrgs } from "@/lib/auth";
import { Nav } from "@/components/nav";
import { CreateOrgForm } from "@/components/create-org-form";

export default async function NewOrgPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const orgs = await getUserOrgs(user.id);

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-md px-4 py-10">
        <div className="mb-6 text-center">
          <h1 className="page-title">
            Create an organization
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            An organization is your board — it holds your seasons, tournaments
            and team members.
          </p>
        </div>
        <CreateOrgForm />
        {orgs.length > 0 && (
          <p className="mt-4 text-center text-sm text-slate-500">
            Already have one?{" "}
            <Link href="/dashboard" className="text-purple-700 hover:underline">
              Go to your board
            </Link>
          </p>
        )}
      </main>
    </>
  );
}
