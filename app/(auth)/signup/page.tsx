import Link from "next/link";
import { Logo } from "@/components/Logo";
import { SignUpForm } from "./signup-form";

export default function SignUpPage() {
  return (
    <main className="min-h-screen grid place-items-center bg-secondary px-4 py-10">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-sm">
        <div className="mb-6 space-y-1.5 text-center">
          <div className="mx-auto flex justify-center">
            <Logo variant="light" size={48} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
          <p className="text-sm text-muted-foreground">For American Hairline & Alchemane team members</p>
        </div>

        <SignUpForm />

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Compassion · Consistency · Innovation · Excellence
        </p>
      </div>
    </main>
  );
}
