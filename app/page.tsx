import { redirect } from "next/navigation";

// Middleware decides /dashboard vs /login based on auth.
export default function RootPage() {
  redirect("/dashboard");
}
