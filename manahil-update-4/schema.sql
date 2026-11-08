-- =====================================================================
-- Manahil Management System: database, roles and security rules
-- Run ONCE in Supabase: SQL Editor > New query > paste all > Run.
-- It is safe to run again later (it will not delete your records).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLES
-- ---------------------------------------------------------------------

-- One row per person who has an account (filled automatically at sign-up).
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null default '',
  email       text not null default '',
  avatar_url  text not null default '',
  is_owner    boolean not null default false,   -- only you can set this, from the SQL editor
  created_at  timestamptz not null default now()
);

-- Every record of the app (students, payments, expenses, ...) lives here.
-- collection = the kind of record, id = its key, data = the record itself.
create table if not exists public.documents (
  collection  text  not null,
  id          text  not null,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);

-- Who may do what, per kind of record. Edit the rows at the bottom of this
-- file to change a role's powers; nothing else needs to change.
create table if not exists public.role_permissions (
  collection  text not null,       -- 'payments', 'students', 'settings/fees', ...
  role        text not null,       -- admin | accountant | teacher | security | viewer
  can_read    boolean not null default false,
  can_insert  boolean not null default false,
  can_update  boolean not null default false,
  can_delete  boolean not null default false,
  primary key (collection, role)
);

-- ---------------------------------------------------------------------
-- 2. AUTOMATIC BEHAVIOUR
-- ---------------------------------------------------------------------

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists documents_touch on public.documents;
create trigger documents_touch before update on public.documents
  for each row execute function public.touch_updated_at();

-- When someone creates an account, give them a profile row (no powers yet).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(coalesce(new.email, ''), '@', 1)),
    coalesce(new.email, '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Profiles for anyone who signed up before you ran this file.
insert into public.profiles (id, name, email)
select u.id,
       coalesce(nullif(u.raw_user_meta_data ->> 'name', ''), split_part(coalesce(u.email, ''), '@', 1)),
       coalesce(u.email, '')
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 3. WHO IS THIS PERSON? (decided here on the server, never in the browser)
-- ---------------------------------------------------------------------
-- The app names people 'u_<uuid>'. The owner assigns roles in the app
-- (Settings > Who can use the system); that is saved in the record
-- settings/access, which ONLY the owner can write (see can_do below).

create or replace function public.app_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then 'none'
    when exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_owner) then 'owner'
    else coalesce(
      (select d.data -> 'roles' -> ('u_' || auth.uid()::text) ->> 'role'
         from public.documents d
        where d.collection = 'settings' and d.id = 'access'),
      'pending')
  end
$$;

-- The one function every read and write goes through.
--   op      : select | insert | update | delete
--   coll    : the kind of record
--   doc_id  : its key
create or replace function public.can_do(op text, coll text, doc_id text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  r   text;
  me  text;
  k   text;
  ok  boolean;
begin
  if auth.uid() is null then
    return false;
  end if;

  r  := public.app_role();
  me := 'u_' || auth.uid()::text;

  -- The owner can do everything, except rewrite the audit trail.
  if r = 'owner' then
    return not (coll = 'audit' and op in ('update', 'delete'));
  end if;

  -- Anyone signed in, even without a role yet, may:
  --   * leave a note that they opened the system / ask for a role (their own record)
  --   * read the portal record the owner prepared for them (parents)
  if coll = 'visitors' and doc_id = me and op in ('select', 'insert', 'update') then
    return true;
  end if;
  if coll = 'portal' and doc_id = me and op = 'select' then
    return true;
  end if;

  -- Everyone else needs one of the five staff roles. 'pending' and 'none' stop here.
  if r not in ('admin', 'accountant', 'teacher', 'security', 'viewer') then
    return false;
  end if;

  -- Staff may write their own presence and extra-hours request records.
  if doc_id = me and coll in ('presence', 'accessReq') and op in ('select', 'insert', 'update') then
    return true;
  end if;

  -- Everything else comes from the role_permissions table.
  k := case when coll = 'settings' then 'settings/' || doc_id else coll end;

  select case op
           when 'select' then can_read
           when 'insert' then can_insert
           when 'update' then can_update
           else can_delete
         end
    into ok
    from public.role_permissions
   where collection = k and role = r;

  return coalesce(ok, false);   -- no row = no access
end $$;

-- ---------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY: the locks
-- ---------------------------------------------------------------------

alter table public.documents        enable row level security;
alter table public.profiles         enable row level security;
alter table public.role_permissions enable row level security;   -- no policies = nobody but you

drop policy if exists documents_select on public.documents;
drop policy if exists documents_insert on public.documents;
drop policy if exists documents_update on public.documents;
drop policy if exists documents_delete on public.documents;

create policy documents_select on public.documents for select to authenticated
  using (public.can_do('select', collection, id));
create policy documents_insert on public.documents for insert to authenticated
  with check (public.can_do('insert', collection, id));
create policy documents_update on public.documents for update to authenticated
  using (public.can_do('update', collection, id))
  with check (public.can_do('update', collection, id));
create policy documents_delete on public.documents for delete to authenticated
  using (public.can_do('delete', collection, id));

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update_self on public.profiles;

create policy profiles_select on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or (select public.app_role()) in ('owner', 'admin', 'accountant', 'teacher', 'security', 'viewer')
  );
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Table privileges (belt and braces on top of the policies).
revoke all on public.documents, public.profiles, public.role_permissions from anon;
revoke all on public.role_permissions from authenticated;
grant select, insert, update, delete on public.documents to authenticated;
grant select on public.profiles to authenticated;
revoke update on public.profiles from authenticated;
grant update (name, avatar_url) on public.profiles to authenticated;   -- NOT is_owner

revoke execute on function public.app_role()                         from public, anon;
revoke execute on function public.can_do(text, text, text)           from public, anon;
grant  execute on function public.app_role()                         to authenticated;
grant  execute on function public.can_do(text, text, text)           to authenticated;

-- ---------------------------------------------------------------------
-- 5. SAVE HELPERS used by the app (they run with the caller's own rights)
-- ---------------------------------------------------------------------

-- Replace a whole record (create it if it does not exist).
create or replace function public.doc_set(p_coll text, p_id text, p_data jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.documents set data = p_data where collection = p_coll and id = p_id;
  if found then
    return;
  end if;
  insert into public.documents (collection, id, data) values (p_coll, p_id, p_data);
exception when unique_violation then
  update public.documents set data = p_data where collection = p_coll and id = p_id;
  if not found then
    raise exception 'You are not allowed to change this record' using errcode = '42501';
  end if;
end $$;

-- Change only some fields of a record, atomically, so two people editing
-- different fields at the same time do not overwrite each other.
create or replace function public.doc_update(p_coll text, p_id text, p_patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.documents set data = data || p_patch where collection = p_coll and id = p_id;
  if not found then
    raise exception 'No such record, or you are not allowed to change it' using errcode = 'P0002';
  end if;
end $$;

revoke execute on function public.doc_set(text, text, jsonb)    from public, anon;
revoke execute on function public.doc_update(text, text, jsonb) from public, anon;
grant  execute on function public.doc_set(text, text, jsonb)    to authenticated;
grant  execute on function public.doc_update(text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 6. LIVE UPDATES (so a payment entered on one phone shows on the others)
-- ---------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.documents;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- ---------------------------------------------------------------------
-- 7. FILE STORAGE (photos, documents, signatures, receipts evidence)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('files', 'files', false, 20971520,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = 20971520,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

drop policy if exists files_read   on storage.objects;
drop policy if exists files_insert on storage.objects;
drop policy if exists files_delete on storage.objects;

create policy files_read on storage.objects for select to authenticated
  using (bucket_id = 'files'
         and (select public.app_role()) in ('owner', 'admin', 'accountant', 'teacher', 'security', 'viewer'));
create policy files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'files'
              and (select public.app_role()) in ('owner', 'admin', 'accountant', 'teacher', 'security'));
create policy files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'files' and (select public.app_role()) = 'owner');

-- ---------------------------------------------------------------------
-- 8. THE PERMISSION TABLE (edit me)
-- ---------------------------------------------------------------------
-- The owner is not listed: the owner can do everything.
-- Roles: admin = Manager, accountant = Finance, teacher, security, viewer.
-- Read the arrays as: who may READ / INSERT (create) / UPDATE / DELETE.

delete from public.role_permissions;

insert into public.role_permissions (collection, role, can_read, can_insert, can_update, can_delete)
select v.c, rl, rl = any (v.rd), rl = any (v.ins), rl = any (v.upd), rl = any (v.del)
from (values
  -- money
  ('payments',        array['admin','accountant','viewer'],                       array['admin','accountant'],                  array['admin','accountant'],         array[]::text[]),
  ('expenses',        array['admin','accountant','viewer'],                       array['admin','accountant'],                  array['admin','accountant'],         array[]::text[]),
  ('cashups',         array['admin','accountant','viewer'],                       array['admin','accountant'],                  array['admin','accountant'],         array[]::text[]),
  ('history',         array['admin','accountant','viewer'],                       array['admin','accountant'],                  array['admin','accountant'],         array[]::text[]),
  -- settings (the owner alone changes fees and access)
  ('settings/fees',   array['admin','accountant','viewer'],                       array[]::text[],                              array[]::text[],                     array[]::text[]),
  ('settings/feedoc', array['admin','accountant','viewer'],                       array[]::text[],                              array[]::text[],                     array[]::text[]),
  ('settings/main',   array['admin','accountant','teacher','security','viewer'],  array['admin','accountant','teacher'],       array['admin','accountant','teacher'], array[]::text[]),
  ('settings/classes',array['admin','accountant','teacher','security','viewer'],  array['admin','teacher'],                     array['admin','teacher'],            array[]::text[]),
  ('settings/arnames',array['admin','accountant','teacher','viewer'],             array['admin','accountant','teacher'],        array['admin','accountant','teacher'], array[]::text[]),
  ('settings/access', array['admin','accountant','teacher','security','viewer'],  array[]::text[],                              array[]::text[],                     array[]::text[]),
  -- students and school life
  ('students',        array['admin','accountant','teacher','security','viewer'],  array['admin','accountant'],                  array['admin','accountant','teacher'], array[]::text[]),
  ('waitlist',        array['admin','accountant','viewer'],                       array['admin','accountant'],                  array['admin','accountant'],         array['admin','accountant']),
  ('attendance',      array['admin','accountant','teacher','viewer'],             array['admin','teacher'],                     array['admin','teacher'],            array[]::text[]),
  ('discipline',      array['admin','teacher','viewer'],                          array['admin','teacher'],                     array['admin','teacher'],            array[]::text[]),
  ('progress',        array['admin','teacher','viewer'],                          array['admin','teacher'],                     array['admin','teacher'],            array[]::text[]),
  ('exams',           array['admin','teacher','viewer'],                          array['admin','teacher'],                     array['admin','teacher'],            array[]::text[]),
  ('subjects',        array['admin','teacher','viewer'],                          array['admin','teacher'],                     array['admin','teacher'],            array[]::text[]),
  ('leaves',          array['admin','accountant','teacher','security','viewer'],  array['admin','teacher','security'],         array['admin','teacher','security'], array[]::text[]),
  -- staff records (HR) : Manager only
  ('staff',           array['admin'],                                             array['admin'],                               array['admin'],                      array[]::text[]),
  -- visits, gate, policies
  ('visits',          array['admin','accountant','teacher','security','viewer'],  array['admin','accountant','teacher'],        array['admin','accountant','teacher'], array[]::text[]),
  ('gatevisitors',    array['admin','accountant','teacher','security','viewer'],  array['admin','accountant','teacher','security'], array['admin','accountant','teacher','security'], array[]::text[]),
  ('policies',        array['admin','accountant','teacher','security','viewer'],  array['admin'],                               array['admin'],                      array[]::text[]),
  -- logs: everyone writes, only the right people read
  ('audit',           array['admin'],                                             array['admin','accountant','teacher','security'], array[]::text[],                  array[]::text[]),
  ('activity',        array[]::text[],                                            array['admin','accountant','teacher','security','viewer'], array[]::text[],         array[]::text[]),
  -- parents' portal records are prepared by the Manager (a parent reads only their own)
  ('portal',          array['admin'],                                             array['admin'],                               array['admin'],                      array[]::text[])
) as v (c, rd, ins, upd, del)
cross join unnest(array['admin','accountant','teacher','security','viewer']) as rl;

-- ---------------------------------------------------------------------
-- 9. AFTER you create your own account in the app, make yourself the owner.
--    Replace the email, select this one statement and run it:
--
--    update public.profiles set is_owner = true where email = 'you@example.com';
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 10. Helper for the SQL editor: make someone an owner in one step.
--     select public.make_owner('them@example.com');
--     (it also clears their old "waiting for access" request)
-- ---------------------------------------------------------------------
create or replace function public.make_owner(p_email text)
returns text language plpgsql as $$
declare v uuid;
begin
  select id into v from public.profiles where lower(email) = lower(trim(p_email));
  if v is null then return 'No account with that email. Ask them to create an account first.'; end if;
  update public.profiles set is_owner = true where id = v;
  delete from public.documents where collection = 'visitors' and id = 'u_' || v::text;
  return 'Done: ' || trim(p_email) || ' is now an owner.';
end $$;
revoke all on function public.make_owner(text) from public, anon, authenticated;
