"use client";

// Workspace-wide team-member lookup. Used by every render site that
// needs to translate an email / user_id into a human-readable name
// (chat header "Assigned to <X>", contact card chip, notes "by <X>",
// reports, etc.). Without this every consumer ended up showing the
// email-prefix as a stand-in for the name, and renaming a member
// never propagated past their own profile page.
//
// Data is fetched once per dashboard mount, refreshed on a 60s timer,
// AND re-fetched whenever a `team-members-changed` window event
// fires (TeamView dispatches it after invite/update/delete).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { memberDisplayName, type TeamMember } from "@/lib/team-types";

interface MembersData {
  /** Indexed by lowercase email so callers can do case-insensitive lookup. */
  byEmail: Map<string, TeamMember>;
  /** Indexed by user_id (auth.users.id) for tables that store the FK
   *  rather than the email (contacts.assigned_to, messages.sender_user_id). */
  byUserId: Map<string, TeamMember>;
  /** Underlying list for components that need to iterate. */
  list: TeamMember[];
}

const EMPTY: MembersData = {
  byEmail: new Map(),
  byUserId: new Map(),
  list: [],
};

const Ctx = createContext<MembersData>(EMPTY);

export function MembersProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<MembersData>(EMPTY);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/team", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()) as { members?: TeamMember[] };
      const list = j.members ?? [];
      const byEmail = new Map<string, TeamMember>();
      const byUserId = new Map<string, TeamMember>();
      for (const m of list) {
        if (m.email) byEmail.set(m.email.toLowerCase(), m);
        if (m.user_id) byUserId.set(m.user_id, m);
      }
      setData({ byEmail, byUserId, list });
    } catch {
      /* silent — empty map = email-prefix fallback */
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 60_000);
    const onChanged = () => void reload();
    window.addEventListener("team-members-changed", onChanged);
    return () => {
      clearInterval(t);
      window.removeEventListener("team-members-changed", onChanged);
    };
  }, [reload]);

  return <Ctx.Provider value={data}>{children}</Ctx.Provider>;
}

export function useMembers(): MembersData {
  return useContext(Ctx);
}

/** Resolve a member's display name from their email. Falls back to
 *  the email-local-part when the workspace map hasn't loaded yet or
 *  the email doesn't match any active member. */
export function useMemberName(email: string | null | undefined): string {
  const { byEmail } = useMembers();
  return useMemo(() => {
    if (!email) return "";
    const m = byEmail.get(email.toLowerCase());
    const name = memberDisplayName(m ?? null);
    if (name) return name;
    return email.includes("@") ? email.split("@")[0] : email;
  }, [byEmail, email]);
}

/** Same as useMemberName but keyed by user_id (auth.users.id). Useful
 *  for tables that store the FK instead of email. */
export function useMemberNameByUserId(
  userId: string | null | undefined,
): string {
  const { byUserId } = useMembers();
  return useMemo(() => {
    if (!userId) return "";
    const m = byUserId.get(userId);
    const name = memberDisplayName(m ?? null);
    return name ?? "";
  }, [byUserId, userId]);
}
