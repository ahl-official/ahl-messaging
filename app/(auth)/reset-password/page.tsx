import { Logo } from "@/components/Logo";
import { ResetPasswordForm } from "./reset-password-form";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const sp = await searchParams;
  const isInvite = sp.invite === "1";

  return (
    <main className="min-h-screen grid place-items-center bg-secondary px-4 py-10">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-sm">
        <div className="mb-6 space-y-1.5 text-center">
          <div className="mx-auto flex justify-center">
            <Logo variant="light" size={48} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {isInvite ? "Set your password" : "Set a new password"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isInvite
              ? "Welcome to AHL Messaging! Choose a password to finish setting up your account."
              : "Choose something at least 8 characters long."}
          </p>
        </div>

        <ResetPasswordForm isInvite={isInvite} />
      </div>
    </main>
  );
}
