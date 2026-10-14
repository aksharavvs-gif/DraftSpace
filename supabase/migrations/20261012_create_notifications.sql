-- DraftSpace notifications table
-- Assumes the existing project already has public.submissions, public.messages, and public.reviewers tables.
-- The schema follows the current Firebase UID-based auth model used elsewhere in the app.

create extension if not exists pgcrypto;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_uid text not null,
  type text not null default 'new_message' check (type in ('new_message')),
  submission_id uuid not null,
  message_id uuid null,
  sender_uid text null,
  sender_name text null,
  submission_name text null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_recipient_created_at_idx
  on public.notifications (recipient_uid, created_at desc);

create index if not exists notifications_unread_idx
  on public.notifications (recipient_uid, is_read, created_at desc);

drop index if exists public.notifications_message_unique_idx;

create unique index if not exists notifications_message_recipient_unique_idx
  on public.notifications (message_id, recipient_uid)
  where message_id is not null and recipient_uid is not null;

-- Optional: helpful if the app later needs to fetch notifications for a given submission.
create index if not exists notifications_recipient_submission_idx
  on public.notifications (recipient_uid, submission_id, created_at desc);

-- Note:
-- This project currently authorizes by Firebase UID and does not rely on client-provided recipient IDs.
-- The notification table should remain protected by server-side checks and Supabase permissions.
