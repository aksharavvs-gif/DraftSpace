alter table public.submissions
  add column if not exists highlights jsonb not null default '[]'::jsonb;

create index if not exists submissions_highlights_gin_idx
  on public.submissions using gin (highlights jsonb_path_ops);
