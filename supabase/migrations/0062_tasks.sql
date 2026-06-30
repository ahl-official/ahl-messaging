-- =====================================================================
-- 0062 — Tasks (admin-assigned work items per agent)
-- ---------------------------------------------------------------------
-- Owner / superadmin / admin can assign tasks to any team member. The
-- panel reports pending / completed / overdue counts per agent and
-- powers the small "Tasks · N" chip in the TopBar.
--
-- Free-form (title + description) with optional linkage to a contact
-- (so the assignee can jump straight to the chat) and/or a WhatsApp
-- business number (so number-scoped tasks group cleanly in reports).
-- Status + priority enums kept conservative — most operator workflows
-- map to one of these. Comments thread lives in a sibling table.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description     text,
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  priority        text NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low','normal','high','urgent')),

  -- Assignment
  assigned_to     uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES public.team_members(id) ON DELETE SET NULL,

  -- Optional linkage so a task can deep-link into the right surface
  contact_id                uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  business_phone_number_id  text,

  due_at          timestamptz,
  completed_at    timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Hot path: "what's open for me right now?"
CREATE INDEX IF NOT EXISTS tasks_assigned_open_idx
  ON public.tasks (assigned_to)
  WHERE status NOT IN ('done','cancelled');

-- Reports & dashboards: status-based aggregations with due-date order.
CREATE INDEX IF NOT EXISTS tasks_status_due_idx
  ON public.tasks (status, due_at);

CREATE INDEX IF NOT EXISTS tasks_created_by_idx
  ON public.tasks (created_by);

CREATE INDEX IF NOT EXISTS tasks_contact_id_idx
  ON public.tasks (contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_bpid_idx
  ON public.tasks (business_phone_number_id)
  WHERE business_phone_number_id IS NOT NULL;

-- Activity / comments thread per task.
CREATE TABLE IF NOT EXISTS public.task_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  /** Kind separates plain comments from auto-generated audit lines
   *  ("status changed open → done", "reassigned to X") so the UI can
   *  render them differently without a second table. */
  kind            text NOT NULL DEFAULT 'comment'
                    CHECK (kind IN ('comment','status_change','assignee_change','due_change')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_comments_task_id_idx
  ON public.task_comments (task_id, created_at DESC);

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_comments ENABLE ROW LEVEL SECURITY;
