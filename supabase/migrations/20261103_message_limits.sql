create or replace function public.insert_message_with_limits(
  p_submission_id uuid,
  p_sender_uid text,
  p_sender_role text,
  p_message text,
  p_sender_name text default null
)
returns public.messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message text;
  v_now timestamptz := now();
  v_short_count integer;
  v_hour_count integer;
  v_oldest_short timestamptz;
  v_oldest_hour timestamptz;
  v_retry_after_ms bigint;
  v_inserted public.messages;
begin
  if p_submission_id is null then
    raise exception 'Submission id is required.' using errcode = '23514';
  end if;

  if p_sender_uid is null or trim(p_sender_uid) = '' then
    raise exception 'User identity is required.' using errcode = '23514';
  end if;

  if p_sender_role is null or trim(p_sender_role) = '' then
    raise exception 'Sender role is required.' using errcode = '23514';
  end if;

  if lower(trim(p_sender_role)) <> 'student' then
    insert into public.messages (
      submission_id,
      sender_uid,
      sender_role,
      sender_name,
      message,
      created_at
    )
    values (
      p_submission_id,
      p_sender_uid,
      p_sender_role,
      p_sender_name,
      trim(p_message),
      v_now
    )
    returning * into v_inserted;

    return v_inserted;
  end if;

  v_message := trim(p_message);
  if v_message = '' then
    raise exception 'Message is required.' using errcode = '23514';
  end if;

  if length(v_message) > 1000 then
    raise exception 'Message exceeds the 1,000-character limit.' using errcode = '23514';
  end if;

  select count(*)
    into v_short_count
  from public.messages
  where sender_uid = p_sender_uid
    and sender_role = 'student'
    and created_at >= v_now - interval '60 seconds';

  if v_short_count >= 5 then
    select min(created_at)
      into v_oldest_short
    from public.messages
    where sender_uid = p_sender_uid
      and sender_role = 'student'
      and created_at >= v_now - interval '60 seconds';

    if v_oldest_short is null then
      v_oldest_short := v_now;
    end if;

    v_retry_after_ms := greatest(0, extract(epoch from (v_oldest_short + interval '60 seconds' - v_now)) * 1000)::bigint;
    raise exception 'rate_limited:%', v_retry_after_ms using errcode = '23514';
  end if;

  select count(*)
    into v_hour_count
  from public.messages
  where sender_uid = p_sender_uid
    and sender_role = 'student'
    and created_at >= v_now - interval '60 minutes';

  if v_hour_count >= 30 then
    select min(created_at)
      into v_oldest_hour
    from public.messages
    where sender_uid = p_sender_uid
      and sender_role = 'student'
      and created_at >= v_now - interval '60 minutes';

    if v_oldest_hour is null then
      v_oldest_hour := v_now;
    end if;

    v_retry_after_ms := greatest(0, extract(epoch from (v_oldest_hour + interval '60 minutes' - v_now)) * 1000)::bigint;
    raise exception 'rate_limited:%', v_retry_after_ms using errcode = '23514';
  end if;

  insert into public.messages (
    submission_id,
    sender_uid,
    sender_role,
    sender_name,
    message,
    created_at
  )
  values (
    p_submission_id,
    p_sender_uid,
    p_sender_role,
    p_sender_name,
    v_message,
    v_now
  )
  returning * into v_inserted;

  return v_inserted;
end;
$$;

create index if not exists idx_messages_sender_created_at
  on public.messages (sender_uid, created_at desc);
