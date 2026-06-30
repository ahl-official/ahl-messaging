-- ============================================================================
-- 0006_template_assets.sql — cache the header media URL for templates
-- ----------------------------------------------------------------------------
-- Meta does not expose a public URL for the sample media a template was
-- approved with — only an opaque resumable-upload handle. To render the
-- same header preview the customer sees (in /templates list, in the
-- composer's TemplatePicker, and in the edit form), we cache our own copy
-- of the image/video/document URL at creation/edit time.
--
-- Linked by Meta's `template_id` so we don't depend on name+language
-- uniqueness across languages. Backfill not possible (we don't have URLs
-- for templates approved before this table existed) — only newly created
-- or edited templates will have entries.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.template_assets (
  template_id     text        PRIMARY KEY,
  template_name   text        NOT NULL,
  language        text        NOT NULL,
  header_format   text        NOT NULL CHECK (header_format IN ('IMAGE', 'VIDEO', 'DOCUMENT')),
  header_url      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS template_assets_name_lang_idx
  ON public.template_assets (template_name, language);

DROP TRIGGER IF EXISTS template_assets_set_updated_at ON public.template_assets;
CREATE TRIGGER template_assets_set_updated_at
  BEFORE UPDATE ON public.template_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- All writes go through server actions using the service-role client, so we
-- only enable RLS to deny by default — no user-facing policy needed for now.
ALTER TABLE public.template_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS template_assets_select_active ON public.template_assets;
CREATE POLICY template_assets_select_active ON public.template_assets
  FOR SELECT
  TO authenticated
  USING (public.current_member_is_active());
