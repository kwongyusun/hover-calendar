-- Hover Calendar: one private row per person, holding their whole calendar.
create table if not exists public.calendars (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.calendars enable row level security;

-- Only you can see or change your own calendar.
drop policy if exists "read own calendar" on public.calendars;
drop policy if exists "add own calendar" on public.calendars;
drop policy if exists "update own calendar" on public.calendars;
create policy "read own calendar" on public.calendars for select using (auth.uid() = user_id);
create policy "add own calendar" on public.calendars for insert with check (auth.uid() = user_id);
create policy "update own calendar" on public.calendars for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
