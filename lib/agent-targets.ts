// Shared targets / score logic. Lives in lib/ so both the API
// endpoints and the score-computing helpers can use it without
// duplicating thresholds.
//
// Score model:
//   Each metric (magic_messages, calls, text_replies, template_sends,
//   login_hours) contributes a ratio actual / target (capped at 1.0).
//   Idle time is inverted: ratio = 1 - max(0, (idle - max_idle)/max_idle),
//   so being within budget = 1.0 and 2× over budget = 0.0.
//   Final score = average of the contributing ratios × 100. Metrics
//   with target = 0 are excluded (operator chose not to enforce them).

import type { Role } from "./team-types";

export interface AgentTargets {
  magic_messages_per_day: number;
  calls_per_day: number;
  text_replies_per_day: number;
  template_sends_per_day: number;
  max_idle_hours_per_day: number;
  min_login_hours_per_day: number;
}

export const TARGET_FIELDS = [
  "magic_messages_per_day",
  "calls_per_day",
  "text_replies_per_day",
  "template_sends_per_day",
  "max_idle_hours_per_day",
  "min_login_hours_per_day",
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];

export interface AgentActuals {
  magic_messages: number;
  calls: number;
  text_replies: number;
  template_sends: number;
  login_hours: number;
  idle_hours: number;
}

export function resolveTargets(
  roleDefaults: AgentTargets,
  override: Partial<AgentTargets> | null,
): AgentTargets {
  if (!override) return roleDefaults;
  const out: AgentTargets = { ...roleDefaults };
  for (const k of TARGET_FIELDS) {
    const v = override[k];
    if (v !== undefined && v !== null) {
      (out as unknown as Record<string, number>)[k] = Number(v);
    }
  }
  return out;
}

export const ROLE_TARGETS_FALLBACK: Record<Role, AgentTargets> = {
  owner: {
    magic_messages_per_day: 0,
    calls_per_day: 0,
    text_replies_per_day: 0,
    template_sends_per_day: 0,
    max_idle_hours_per_day: 24,
    min_login_hours_per_day: 0,
  },
  superadmin: {
    magic_messages_per_day: 0,
    calls_per_day: 0,
    text_replies_per_day: 0,
    template_sends_per_day: 0,
    max_idle_hours_per_day: 24,
    min_login_hours_per_day: 0,
  },
  admin: {
    magic_messages_per_day: 5,
    calls_per_day: 5,
    text_replies_per_day: 30,
    template_sends_per_day: 5,
    max_idle_hours_per_day: 4,
    min_login_hours_per_day: 6,
  },
  teammate: {
    magic_messages_per_day: 10,
    calls_per_day: 10,
    text_replies_per_day: 50,
    template_sends_per_day: 10,
    max_idle_hours_per_day: 3,
    min_login_hours_per_day: 7,
  },
};

export interface ScoreBreakdown {
  /** 0–100. NaN-safe: when nothing is being measured we return 100. */
  score: number;
  tier: "green" | "yellow" | "red";
  /** Per-metric ratio (0–1) so the UI can show why the score is low. */
  contributors: Array<{
    label: string;
    target: number;
    actual: number;
    ratio: number;
  }>;
}

function ratioFor(target: number, actual: number): number {
  if (target <= 0) return Number.NaN; // exclude
  return Math.min(1, actual / target);
}
function idleRatio(maxIdle: number, idle: number): number {
  if (maxIdle <= 0) return Number.NaN;
  if (idle <= maxIdle) return 1;
  // Linear penalty: 2× over budget → 0
  const overshoot = (idle - maxIdle) / maxIdle;
  return Math.max(0, 1 - overshoot);
}

export function computeScore(
  targets: AgentTargets,
  actuals: AgentActuals,
): ScoreBreakdown {
  const contributors: ScoreBreakdown["contributors"] = [];
  const tryAdd = (label: string, target: number, actual: number, ratio: number) => {
    if (Number.isNaN(ratio)) return;
    contributors.push({ label, target, actual, ratio });
  };
  tryAdd(
    "Magic messages",
    targets.magic_messages_per_day,
    actuals.magic_messages,
    ratioFor(targets.magic_messages_per_day, actuals.magic_messages),
  );
  tryAdd(
    "Calls",
    targets.calls_per_day,
    actuals.calls,
    ratioFor(targets.calls_per_day, actuals.calls),
  );
  tryAdd(
    "Text replies",
    targets.text_replies_per_day,
    actuals.text_replies,
    ratioFor(targets.text_replies_per_day, actuals.text_replies),
  );
  tryAdd(
    "Template sends",
    targets.template_sends_per_day,
    actuals.template_sends,
    ratioFor(targets.template_sends_per_day, actuals.template_sends),
  );
  tryAdd(
    "Login hours",
    targets.min_login_hours_per_day,
    actuals.login_hours,
    ratioFor(targets.min_login_hours_per_day, actuals.login_hours),
  );
  tryAdd(
    "Idle hours",
    targets.max_idle_hours_per_day,
    actuals.idle_hours,
    idleRatio(targets.max_idle_hours_per_day, actuals.idle_hours),
  );

  if (contributors.length === 0) {
    return { score: 100, tier: "green", contributors };
  }
  const avg = contributors.reduce((a, c) => a + c.ratio, 0) / contributors.length;
  const score = Math.round(avg * 100);
  const tier: ScoreBreakdown["tier"] =
    score >= 95 ? "green" : score >= 75 ? "yellow" : "red";
  return { score, tier, contributors };
}
