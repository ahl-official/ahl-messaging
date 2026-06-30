-- Contact avatar_url — operator-uploaded profile photo for the contact.
-- Stored as a public URL pointing at the `contact-avatars` Supabase
-- Storage bucket (created below). Public bucket = no signed URLs needed
-- so the contact list renders avatars without per-row API calls.

alter table public.contacts
  add column if not exists avatar_url text;

-- Storage bucket for the uploaded photos. `public = true` so the URL
-- can be used directly in <img>. Operator uploads go through the
-- /api/contacts/[id]/avatar route which uses the service role.
insert into storage.buckets (id, name, public)
values ('contact-avatars', 'contact-avatars', true)
on conflict (id) do update set public = true;

-- Bucket policies — anyone can read (public bucket); writes are
-- restricted to authenticated users (we additionally check membership
-- + admin role at the API layer).
drop policy if exists "contact-avatars-read" on storage.objects;
create policy "contact-avatars-read"
  on storage.objects for select
  using (bucket_id = 'contact-avatars');

drop policy if exists "contact-avatars-write" on storage.objects;
create policy "contact-avatars-write"
  on storage.objects for insert
  with check (bucket_id = 'contact-avatars' and auth.role() = 'authenticated');

drop policy if exists "contact-avatars-update" on storage.objects;
create policy "contact-avatars-update"
  on storage.objects for update
  using (bucket_id = 'contact-avatars' and auth.role() = 'authenticated');

drop policy if exists "contact-avatars-delete" on storage.objects;
create policy "contact-avatars-delete"
  on storage.objects for delete
  using (bucket_id = 'contact-avatars' and auth.role() = 'authenticated');

notify pgrst, 'reload schema';
