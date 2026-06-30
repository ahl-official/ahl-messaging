-- Atomic unread bump. The webhooks were doing SELECT unread_count -> +1 ->
-- UPDATE, which loses an increment whenever two inbound messages for the same
-- contact race between the read and the write. One atomic statement fixes it.

create or replace function public.bump_unread(p_contact_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.contacts
     set unread_count = coalesce(unread_count, 0) + 1
   where id = p_contact_id;
$$;

grant execute on function public.bump_unread(uuid) to anon, authenticated, service_role;
