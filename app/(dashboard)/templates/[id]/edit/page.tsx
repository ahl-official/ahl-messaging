import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { TemplateCreate, type InitialTemplate } from "@/components/TemplateCreate";
import { createServerClient, createServiceRoleClient } from "@/lib/supabase/server";
import { DEMO_MODE } from "@/lib/demo";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
  // The template list is per-number (each number resolves to a Meta
  // WABA). The edit link carries portfolio_key + phone_number_id so the
  // detail fetch hits the SAME account — without it the API falls back
  // to a default and Meta returns "Object … does not exist".
  searchParams: Promise<{ portfolio_key?: string; phone_number_id?: string }>;
}

export default async function EditTemplatePage({ params, searchParams }: Props) {
  const { id } = await params;
  const { portfolio_key, phone_number_id } = await searchParams;
  const portfolioQs = (() => {
    const p = new URLSearchParams();
    if (portfolio_key) p.set("portfolio_key", portfolio_key);
    if (phone_number_id) p.set("phone_number_id", phone_number_id);
    const s = p.toString();
    return s ? `?${s}` : "";
  })();

  if (!DEMO_MODE) {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) redirect("/login");
  }

  // Fetch the template's current structure from Meta via our own API (which
  // applies the auth + access-token plumbing).
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = host.includes("localhost") ? "http" : "https";
  const cookie = h.get("cookie") ?? "";

  let template: InitialTemplate | null = null;
  let fetchError: string | null = null;
  try {
    const res = await fetch(
      `${proto}://${host}/api/templates/${encodeURIComponent(id)}${portfolioQs}`,
      {
        headers: { cookie },
        cache: "no-store",
      },
    );
    const j = (await res.json()) as { template?: InitialTemplate; error?: string };
    if (!res.ok) {
      fetchError = j.error ?? `HTTP ${res.status}`;
    } else if (j.template) {
      template = j.template;
    }
  } catch (e) {
    fetchError = e instanceof Error ? e.message : "Failed to load template";
  }

  // Pull cached header preview URL (if any) so the form can prefill it.
  if (template) {
    const admin = createServiceRoleClient();
    const { data: asset } = await admin
      .from("template_assets")
      .select("header_url")
      .eq("template_id", id)
      .maybeSingle();
    if (asset?.header_url) {
      template.header_url = asset.header_url;
    }
  }

  if (fetchError || !template) {
    return (
      <div className="grid h-full place-items-center bg-secondary/30 px-6">
        <div className="max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
          <h1 className="text-base font-semibold">Couldn&apos;t load template</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {fetchError ?? "Template not found."}
          </p>
          <Link
            href="/templates"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Back to Templates
          </Link>
        </div>
      </div>
    );
  }

  return (
    <TemplateCreate
      businessName={process.env.WHATSAPP_DISPLAY_NAME ?? "URoots by QHT"}
      initialTemplate={template}
    />
  );
}
