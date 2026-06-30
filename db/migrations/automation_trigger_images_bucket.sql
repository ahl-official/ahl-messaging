-- Public storage bucket for trigger-image uploads (used by the
-- Automation page's "Trigger phrases → send image" editor). Public
-- so the URL stored in image_response_triggers.image_url can be
-- fetched directly by Meta when the bot dispatches the image.

insert into storage.buckets (id, name, public)
values ('automation-trigger-images', 'automation-trigger-images', true)
on conflict (id) do update set public = true;

drop policy if exists "trigger-images-read" on storage.objects;
create policy "trigger-images-read"
  on storage.objects for select
  using (bucket_id = 'automation-trigger-images');

drop policy if exists "trigger-images-write" on storage.objects;
create policy "trigger-images-write"
  on storage.objects for insert
  with check (bucket_id = 'automation-trigger-images' and auth.role() = 'authenticated');

drop policy if exists "trigger-images-update" on storage.objects;
create policy "trigger-images-update"
  on storage.objects for update
  using (bucket_id = 'automation-trigger-images' and auth.role() = 'authenticated');

drop policy if exists "trigger-images-delete" on storage.objects;
create policy "trigger-images-delete"
  on storage.objects for delete
  using (bucket_id = 'automation-trigger-images' and auth.role() = 'authenticated');
