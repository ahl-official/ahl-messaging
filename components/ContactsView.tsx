"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Columns,
  Filter,
  Loader2,
  Megaphone,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Users,
  X,
} from "lucide-react";
import { updateContactNameAction, setContactTagsAction } from "@/app/(dashboard)/actions";
import { cn } from "@/lib/utils";
import { toneForKey } from "@/lib/chip-tones";
import { Input } from "@/components/ui/input";
import { contactDisplayNameMasked, type Contact } from "@/lib/types";
import { formatPhone } from "@/lib/phone";
import { PremiumHeader } from "@/components/PremiumHeader";
import { usePermissions, usePhoneMasker } from "@/components/PermissionsContext";
import { useMembers } from "@/components/MembersContext";
import { memberDisplayName } from "@/lib/team-types";

interface Props {
  contacts: Contact[];
  total: number;
  page: number;
  pageSize: number;
  query: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const dd = d.getDate().toString().padStart(2, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export function ContactsView({ contacts, total, page, pageSize, query }: Props) {
  const router = useRouter();
  const members = useMembers();
  const perms = usePermissions();
  const maskPhone = usePhoneMasker();
  const [q, setQ] = useState(query);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  // Edit-dialog state — open with a specific contact row so the modal
  // can pre-fill name + tags. null = closed.
  const [editing, setEditing] = useState<Contact | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const allChecked = contacts.length > 0 && contacts.every((c) => selected.has(c.id));

  const pageLinks = useMemo(() => {
    const pages: number[] = [];
    const start = Math.max(1, page - 1);
    const end = Math.min(totalPages, start + 2);
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  }, [page, totalPages]);

  function navigateTo(nextPage: number, nextQ = q) {
    const params = new URLSearchParams();
    if (nextPage > 1) params.set("page", String(nextPage));
    if (nextQ) params.set("q", nextQ);
    router.push(`/contacts${params.toString() ? `?${params}` : ""}`);
  }

  function onSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigateTo(1, q.trim());
  }

  function toggleAll() {
    if (allChecked) setSelected(new Set());
    else setSelected(new Set(contacts.map((c) => c.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col bg-secondary/30">
      <PremiumHeader
        icon={Users}
        title="Contact Hub"
        subtitle="Seamlessly manage all your contacts in one place — sales, support and beyond."
        tone="violet"
        right={
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-xs font-semibold text-emerald-800 shadow-lg shadow-emerald-900/25 ring-1 ring-white/40 transition hover:shadow-xl"
          >
            <Plus className="h-3.5 w-3.5" />
            Create contact
          </button>
        }
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-card px-6 py-3">
        <div className="flex flex-1 items-center gap-2">
          <form onSubmit={onSearchSubmit} className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search users by name or phone number"
              className="h-9 pl-9 text-sm"
            />
          </form>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-secondary"
            title="Filters — coming soon"
            disabled
          >
            <Filter className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground opacity-60"
            title="Broadcast campaigns — coming soon"
          >
            <Megaphone className="h-3.5 w-3.5" />
            Send Notifications
          </button>
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground opacity-60"
            title="Bulk actions — coming soon"
          >
            <MoreVertical className="h-3.5 w-3.5" />
            More Actions
          </button>
        </div>
        <button
          type="button"
          disabled
          className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground opacity-60"
          title="Coming soon"
        >
          <Columns className="h-3.5 w-3.5" />
          Modify Columns
        </button>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {contacts.length === 0 ? (
          <div className="grid h-60 place-items-center text-center text-sm text-muted-foreground">
            {query ? (
              <>
                No contacts match <strong>&ldquo;{query}&rdquo;</strong>.{" "}
                <button
                  type="button"
                  onClick={() => {
                    setQ("");
                    navigateTo(1, "");
                  }}
                  className="text-primary hover:underline"
                >
                  Clear search
                </button>
              </>
            ) : (
              "No contacts yet — inbound WhatsApp messages will create contacts automatically."
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-separate border-spacing-0 bg-card text-sm">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="text-left">
                <th className="w-10 border-b px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    className="h-4 w-4 cursor-pointer"
                  />
                </th>
                <Th>Contact Name</Th>
                <Th>id</Th>
                <Th>Phone Number</Th>
                <Th>Tags</Th>
                <Th>Status</Th>
                <Th>Assigned to</Th>
                <Th>Created On</Th>
                <Th>Source</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => {
                const name = contactDisplayNameMasked(c, perms.mask_phone_numbers);
                const isChecked = selected.has(c.id);
                const status = c.status ?? "open";
                return (
                  <tr
                    key={c.id}
                    className={cn(
                      "border-b transition hover:bg-secondary/60",
                      isChecked && "bg-primary/5",
                    )}
                  >
                    <td className="w-10 border-b px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleOne(c.id)}
                        className="h-4 w-4 cursor-pointer"
                      />
                    </td>
                    <td className="border-b px-4 py-2.5">
                      <Link
                        href={`/dashboard?contact=${c.id}`}
                        className="font-medium text-foreground hover:text-primary hover:underline"
                      >
                        {name}
                      </Link>
                    </td>
                    <td className="border-b px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
                      {c.id.slice(0, 8)}…{c.id.slice(-4)}
                    </td>
                    <td className="border-b px-4 py-2.5 text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <span>{maskPhone(formatPhone(c.wa_id))}</span>
                        {c.linked_numbers_count && c.linked_numbers_count > 1 ? (
                          <span
                            className="inline-flex items-center rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 ring-1 ring-inset ring-violet-200"
                            title={`This patient has ${c.linked_numbers_count} contact rows — one per business number they messaged.`}
                          >
                            × {c.linked_numbers_count} numbers
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="border-b px-4 py-2.5">
                      {c.tags && c.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {c.tags.slice(0, 3).map((t) => (
                            <span
                              key={t}
                              className="inline-flex rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] font-medium text-primary"
                            >
                              {t}
                            </span>
                          ))}
                          {c.tags.length > 3 ? (
                            <span className="text-[10px] text-muted-foreground">+{c.tags.length - 3}</span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="border-b px-4 py-2.5">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                          status === "open"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-slate-200 text-slate-700",
                        )}
                      >
                        {status}
                      </span>
                    </td>
                    <td className="border-b px-4 py-2.5 text-muted-foreground">
                      {c.assigned_to_email ? (
                        memberDisplayName(
                          members.byEmail.get(c.assigned_to_email.toLowerCase()) ??
                            null,
                        ) ?? c.assigned_to_email.split("@")[0]
                      ) : c.lsq_owner_name ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
                            toneForKey(c.lsq_owner_email || c.lsq_owner_name).bg,
                            toneForKey(c.lsq_owner_email || c.lsq_owner_name).text,
                            toneForKey(c.lsq_owner_email || c.lsq_owner_name).ring,
                          )}
                          title={`LSQ lead owner: ${c.lsq_owner_name}`}
                        >
                          {c.lsq_owner_name}
                        </span>
                      ) : (
                        "Unassigned"
                      )}
                    </td>
                    <td className="border-b px-4 py-2.5 text-muted-foreground">{formatDate(c.created_at)}</td>
                    <td className="border-b px-4 py-2.5">
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[8px] font-bold text-white">
                          W
                        </span>
                        WhatsApp
                      </span>
                    </td>
                    <td className="border-b px-4 py-2.5">
                      <button
                        type="button"
                        onClick={() => setEditing(c)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-input bg-background px-2 text-[11px] font-semibold text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                        title="Edit name & tags"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Footer / Pagination */}
      <div className="flex items-center justify-between gap-2 border-t bg-card px-6 py-2.5">
        <div className="text-xs text-muted-foreground">
          Total Users: <strong className="text-foreground">{total.toLocaleString()}</strong>
          {selected.size > 0 ? (
            <span className="ml-3 text-primary">· {selected.size} selected</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => navigateTo(page - 1)}
            disabled={page <= 1}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-secondary disabled:opacity-40"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          {pageLinks.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => navigateTo(p)}
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs font-semibold",
                p === page
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background text-muted-foreground hover:bg-secondary",
              )}
            >
              {p}
            </button>
          ))}
          <button
            type="button"
            onClick={() => navigateTo(page + 1)}
            disabled={page >= totalPages}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-secondary disabled:opacity-40"
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {createOpen ? (
        <CreateContactDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      ) : null}

      {editing ? (
        <EditContactDialog
          contact={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b bg-card px-4 py-2.5 text-xs font-semibold text-muted-foreground">
      {children}
    </th>
  );
}

function CreateContactDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Create on the operator's active number instead of letting the API
  // silently default to the global "Test" number (WHATSAPP_PHONE_NUMBER_ID).
  const [defaultNumber, setDefaultNumber] = useState("");
  useEffect(() => {
    fetch("/api/business-numbers", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { numbers?: Array<{ phone_number_id: string; provider?: string; is_active?: boolean }> }) => {
        const usable = (j.numbers ?? []).filter((n) => n.provider !== "evolution");
        const active = usable.find((n) => n.is_active) ?? usable[0];
        if (active) setDefaultNumber(active.phone_number_id);
      })
      .catch(() => {});
  }, []);

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (!t) return;
    if (tags.includes(t)) {
      setTagInput("");
      return;
    }
    setTags([...tags, t]);
    setTagInput("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim(), tags, business_phone_number_id: defaultNumber || undefined }),
      });
      // Server may return non-JSON on a hard crash (Next.js shows an
      // HTML error page). Read text first, parse if it looks like JSON
      // so the operator sees the real status/body instead of the
      // cryptic "Unexpected end of JSON input".
      const text = await res.text();
      let j: { contact?: unknown; error?: string } = {};
      if (text.trim().startsWith("{")) {
        try {
          j = JSON.parse(text);
        } catch {
          /* leave j empty — text wasn't valid JSON */
        }
      }
      if (!res.ok) {
        throw new Error(
          j.error ??
            (text.trim() ? text.slice(0, 200) : `HTTP ${res.status}`),
        );
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <form onSubmit={save} className="w-full max-w-md rounded-lg border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="text-sm font-semibold">Create Contact</div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <div>
            <label className="mb-1 block text-xs font-semibold">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              className="h-9 text-sm"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold">Phone Number</label>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 9876543210"
              className="h-9 text-sm"
              required
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Include country code. Digits and + only.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold">Tags</label>
            <div className="flex flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1.5">
              {tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                    className="hover:text-destructive"
                    aria-label={`Remove ${t}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag();
                  } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
                    setTags(tags.slice(0, -1));
                  }
                }}
                placeholder={tags.length === 0 ? "Type and press Enter" : ""}
                className="min-w-[80px] flex-1 bg-transparent text-sm focus:outline-none"
              />
            </div>
          </div>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim() || !phone.trim()}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------
// Edit dialog — change a contact's name + tags. Phone is intentionally
// read-only (it's the WhatsApp identity; changing it would orphan the
// chat history). Calls the same server actions the inline chat-side
// NameEditor uses, so name edits mirror to the LSQ lead automatically.
// ---------------------------------------------------------------------
function EditContactDialog({
  contact,
  onClose,
  onSaved,
}: {
  contact: Contact;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(contact.name ?? "");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>(contact.tags ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (!t) return;
    if (tags.includes(t)) {
      setTagInput("");
      return;
    }
    setTags([...tags, t]);
    setTagInput("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      // Two server actions — name update + tags update. Run sequentially
      // so a tag failure can't strand a name change at "saved" state.
      const nameResult = await updateContactNameAction(contact.id, name.trim());
      if ("error" in nameResult) throw new Error(nameResult.error);

      const initialTags = (contact.tags ?? []).slice().sort();
      const newTags = tags.slice().sort();
      const tagsChanged =
        initialTags.length !== newTags.length ||
        initialTags.some((t, i) => t !== newTags[i]);
      if (tagsChanged) {
        const tagsResult = await setContactTagsAction(contact.id, tags);
        if ("error" in tagsResult) throw new Error(tagsResult.error);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <form onSubmit={save} className="w-full max-w-md rounded-lg border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-sm font-semibold">Edit Contact</div>
            <div className="text-[11px] text-muted-foreground">
              {formatPhone(contact.wa_id)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <div>
            <label className="mb-1 block text-xs font-semibold">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              className="h-9 text-sm"
              autoFocus
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Mirrors to LSQ lead&apos;s FirstName when saved.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold">Tags</label>
            <div className="flex flex-wrap items-center gap-1 rounded-md border border-input bg-background px-2 py-1.5">
              {tags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                >
                  {t}
                  <button
                    type="button"
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                    className="hover:text-destructive"
                    aria-label={`Remove ${t}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag();
                  } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
                    setTags(tags.slice(0, -1));
                  }
                }}
                placeholder={tags.length === 0 ? "Type and press Enter" : ""}
                className="min-w-[80px] flex-1 bg-transparent text-sm focus:outline-none"
              />
            </div>
          </div>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t bg-secondary/30 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border bg-background px-3 py-1.5 text-sm font-semibold hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
