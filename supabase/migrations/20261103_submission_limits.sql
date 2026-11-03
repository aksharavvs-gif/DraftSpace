create or replace function public.submit_submission_with_limits(
  p_user_id text,
  p_title text,
  p_stage text,
  p_writing_type text,
  p_draft text,
  p_context text,
  p_comments jsonb default '[]'::jsonb,
  p_question_replies jsonb default '[]'::jsonb,
  p_user_email text default null,
  p_review_status text default 'Awaiting review',
  p_response_time text default 'Within 72 hours'
)
returns setof public.submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_word_count integer;
  v_recent_count integer;
  v_last_submission_at timestamptz;
  v_now timestamptz := now();
begin
  if p_user_id is null or trim(p_user_id) = '' then
    raise exception 'User identity is required.' using errcode = '23514';
  end if;

  if p_draft is null then
    raise exception 'Submission draft is required.' using errcode = '23514';
  end if;

  v_word_count := array_length(regexp_split_to_array(trim(p_draft), '\s+'), 1);
  if v_word_count is null then
    v_word_count := 0;
  end if;

  if v_word_count > 3000 then
    raise exception 'Submission exceeds the 3,000-word limit.' using errcode = '23514';
  end if;

  select count(*)
    into v_recent_count
  from public.submissions
  where user_id = p_user_id
    and submitted_at >= v_now - interval '24 hours';

  if v_recent_count >= 5 then
    raise exception 'Daily submission limit reached.' using errcode = '23514';
  end if;

  select max(submitted_at)
    into v_last_submission_at
  from public.submissions
  where user_id = p_user_id;

  if v_last_submission_at is not null and v_last_submission_at >= v_now - interval '30 minutes' then
    raise exception 'Please wait before submitting again.' using errcode = '23514';
  end if;

  return query
  insert into public.submissions (
    title,
    review_status,
    response_time,
    stage,
    writing_type,
    draft,
    context,
    feedback,
    comments,
    question_replies,
    user_id,
    user_email,
    submitted_at
  )
  values (
    coalesce(p_title, ''),
    coalesce(p_review_status, 'Awaiting review'),
    coalesce(p_response_time, 'Within 72 hours'),
    p_stage,
    coalesce(p_writing_type, ''),
    p_draft,
    coalesce(p_context, ''),
    null,
    coalesce(p_comments, '[]'::jsonb),
    coalesce(p_question_replies, '[]'::jsonb),
    p_user_id,
    p_user_email,
    v_now
  )
  returning *;
end;
$$;

create index if not exists idx_submissions_user_submitted_at
  on public.submissions (user_id, submitted_at desc);
