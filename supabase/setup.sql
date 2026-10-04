-- Pry.it migration for the database currently used by the bot.
-- Keeps the existing BIGINT bounty IDs and all existing bounty rows.
-- The current submissions table is empty; its bounty_id is changed from UUID to BIGINT.

BEGIN;

DO $$
DECLARE
  bounty_id_type text;
  user_id_type text;
  telegram_id_type text;
  submission_bounty_id_type text;
  submission_rows bigint;
BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.bounties') IS NULL THEN
    RAISE EXCEPTION 'Pry.it migration stopped: public.users and public.bounties must exist.';
  END IF;

  SELECT data_type INTO bounty_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'bounties' AND column_name = 'id';

  IF bounty_id_type IS DISTINCT FROM 'bigint' THEN
    RAISE EXCEPTION 'Pry.it migration stopped: expected the existing BIGINT bounties.id.';
  END IF;

  SELECT data_type INTO user_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id';

  SELECT data_type INTO telegram_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'telegram_id';

  IF user_id_type IS DISTINCT FROM 'uuid' OR telegram_id_type IS DISTINCT FROM 'bigint' THEN
    RAISE EXCEPTION 'Pry.it migration stopped: users must have UUID id and BIGINT telegram_id.';
  END IF;

  IF EXISTS (
    SELECT required.column_name
    FROM (VALUES ('title'), ('reward'), ('description'), ('status'), ('created_at'), ('creator_id'), ('executor_id')) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'bounties'
        AND column_name = required.column_name
    )
  ) THEN
    RAISE EXCEPTION 'Pry.it migration stopped: the old bounties table is missing an expected column.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bounties
    WHERE status IS NOT NULL
      AND status NOT IN ('pending_payment', 'pending_approval', 'active', 'open', 'in_progress', 'review', 'completed', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Pry.it migration stopped: there is an unrecognized bounty status.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.bounties WHERE reward <= 0) THEN
    RAISE EXCEPTION 'Pry.it migration stopped: a bounty has a zero or negative reward.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bounties b
    LEFT JOIN public.users u ON u.telegram_id = b.creator_id
    WHERE b.status NOT IN ('completed', 'cancelled')
      AND (b.creator_id IS NULL OR u.id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Pry.it migration stopped: an unfinished bounty has no matching client account.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bounties b
    LEFT JOIN public.users u ON u.telegram_id = b.executor_id
    WHERE b.executor_id IS NOT NULL AND u.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Pry.it migration stopped: an assigned executor has no matching user account.';
  END IF;

  IF to_regclass('public.submissions') IS NOT NULL THEN
    SELECT data_type INTO submission_bounty_id_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'submissions' AND column_name = 'bounty_id';

    IF submission_bounty_id_type NOT IN ('uuid', 'bigint') THEN
      RAISE EXCEPTION 'Pry.it migration stopped: submissions.bounty_id must currently be UUID or BIGINT.';
    END IF;

    IF submission_bounty_id_type = 'uuid' THEN
      SELECT count(*) INTO submission_rows FROM public.submissions;
      IF submission_rows <> 0 THEN
        RAISE EXCEPTION 'Pry.it migration stopped: submissions contains rows and needs a separate safe conversion.';
      END IF;
    END IF;
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Keep the old BIGINT primary key and source columns; add fields used by the new bot.
ALTER TABLE public.bounties ADD COLUMN IF NOT EXISTS client_id uuid;
ALTER TABLE public.bounties ADD COLUMN IF NOT EXISTS winner_id uuid;
ALTER TABLE public.bounties ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'Інше';
ALTER TABLE public.bounties ADD COLUMN IF NOT EXISTS budget numeric;
ALTER TABLE public.bounties ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE public.bounties ADD COLUMN IF NOT EXISTS deadline timestamptz;
ALTER TABLE public.bounties ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE public.bounties b
SET client_id = u.id
FROM public.users u
WHERE b.client_id IS NULL AND b.creator_id = u.telegram_id;

UPDATE public.bounties b
SET winner_id = u.id
FROM public.users u
WHERE b.winner_id IS NULL AND b.executor_id = u.telegram_id;

UPDATE public.bounties
SET budget = reward
WHERE budget IS NULL;

ALTER TABLE public.bounties
  DROP CONSTRAINT IF EXISTS bounties_status_check;

UPDATE public.bounties
SET status = CASE
  WHEN status = 'pending_payment' THEN 'pending_approval'
  WHEN status = 'active' THEN 'open'
  WHEN status IS NULL THEN 'pending_approval'
  ELSE status
END;

UPDATE public.bounties
SET currency = 'UAH'
WHERE currency IS NULL;

UPDATE public.bounties
SET deadline = CASE
  WHEN status IN ('pending_approval', 'open', 'in_progress', 'review') THEN now() + interval '30 days'
  ELSE coalesce(created_at, now()) + interval '30 days'
END
WHERE deadline IS NULL;

UPDATE public.bounties
SET updated_at = coalesce(created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE public.bounties
  ALTER COLUMN budget SET NOT NULL,
  ALTER COLUMN budget DROP DEFAULT,
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN currency SET DEFAULT 'UAH',
  ALTER COLUMN deadline SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'pending_approval',
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now();

ALTER TABLE public.bounties
  DROP CONSTRAINT IF EXISTS bounties_budget_positive_check;
ALTER TABLE public.bounties
  ADD CONSTRAINT bounties_budget_positive_check CHECK (budget > 0);

ALTER TABLE public.bounties
  ADD CONSTRAINT bounties_status_check
  CHECK (status IN ('pending_approval', 'open', 'in_progress', 'review', 'completed', 'cancelled'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'bounties_client_id_fkey'
  ) THEN
    ALTER TABLE public.bounties
      ADD CONSTRAINT bounties_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.bounties'::regclass AND conname = 'bounties_winner_id_fkey'
  ) THEN
    ALTER TABLE public.bounties
      ADD CONSTRAINT bounties_winner_id_fkey
      FOREIGN KEY (winner_id) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id bigint NOT NULL,
  freelancer_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  proposal_text text NOT NULL DEFAULT '',
  work_url text,
  proposed_budget numeric(10, 2),
  delivery_url text,
  revision_note text,
  is_winner boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  submission_bounty_id_type text;
BEGIN
  SELECT data_type INTO submission_bounty_id_type
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'submissions' AND column_name = 'bounty_id';

  IF submission_bounty_id_type = 'uuid' THEN
    ALTER TABLE public.submissions
      ALTER COLUMN bounty_id TYPE bigint USING NULL::bigint;
  END IF;
END
$$;

ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS proposal_text text NOT NULL DEFAULT '';
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS proposed_budget numeric(10, 2);
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS delivery_url text;
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS revision_note text;
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS work_url text;
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS is_winner boolean NOT NULL DEFAULT false;
ALTER TABLE public.submissions ALTER COLUMN work_url DROP NOT NULL;

UPDATE public.submissions SET is_winner = false WHERE is_winner IS NULL;
ALTER TABLE public.submissions
  ALTER COLUMN is_winner SET DEFAULT false,
  ALTER COLUMN is_winner SET NOT NULL;

ALTER TABLE public.submissions
  DROP CONSTRAINT IF EXISTS submissions_proposed_budget_check;
ALTER TABLE public.submissions
  ADD CONSTRAINT submissions_proposed_budget_check
  CHECK (proposed_budget IS NULL OR proposed_budget > 0);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.submissions'::regclass AND conname = 'submissions_bounty_id_fkey'
  ) THEN
    ALTER TABLE public.submissions
      ADD CONSTRAINT submissions_bounty_id_fkey
      FOREIGN KEY (bounty_id) REFERENCES public.bounties(id) ON DELETE CASCADE NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON public.users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_bounties_status ON public.bounties(status);
CREATE INDEX IF NOT EXISTS idx_bounties_client_id ON public.bounties(client_id);
CREATE INDEX IF NOT EXISTS idx_submissions_bounty_id ON public.submissions(bounty_id);
CREATE INDEX IF NOT EXISTS idx_submissions_freelancer_id ON public.submissions(freelancer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_submission ON public.submissions(bounty_id, freelancer_id);

CREATE TABLE IF NOT EXISTS public.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bounty_id bigint NOT NULL REFERENCES public.bounties(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reviewee_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reviews_one_per_user_per_project UNIQUE (bounty_id, reviewer_id),
  CONSTRAINT reviews_no_self_review CHECK (reviewer_id <> reviewee_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewee_id ON public.reviews(reviewee_id);

-- The old bot stored the assigned Telegram ID on the bounty, but never saved
-- the proposal row. Add a minimal selected proposal so the new delivery flow
-- can continue. Legacy "review" projects stay reviewable; no old work files
-- are fabricated or attached.
INSERT INTO public.submissions (bounty_id, freelancer_id, proposal_text, proposed_budget, is_winner)
SELECT b.id, b.winner_id, 'Імпортовано з попередньої версії Pry.it.', b.budget, true
FROM public.bounties b
WHERE b.winner_id IS NOT NULL
ON CONFLICT (bounty_id, freelancer_id) DO NOTHING;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bounties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.bounties, public.submissions, public.reviews TO service_role;

DO $$
DECLARE
  bounty_sequence text;
BEGIN
  bounty_sequence := pg_get_serial_sequence('public.bounties', 'id');
  IF bounty_sequence IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', bounty_sequence);
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.choose_bounty_winner(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.submit_bounty_delivery(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.request_bounty_revision(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.choose_bounty_winner(
  p_bounty_id bigint,
  p_submission_id uuid,
  p_client_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  chosen_freelancer uuid;
BEGIN
  UPDATE public.bounties AS b
  SET status = 'in_progress',
      winner_id = s.freelancer_id,
      updated_at = now()
  FROM public.submissions AS s
  WHERE b.id = p_bounty_id
    AND b.client_id = p_client_id
    AND b.status = 'open'
    AND b.deadline > now()
    AND s.id = p_submission_id
    AND s.bounty_id = b.id
  RETURNING b.winner_id INTO chosen_freelancer;

  IF chosen_freelancer IS NULL THEN
    RAISE EXCEPTION 'Project is no longer open or proposal does not belong to it.';
  END IF;

  UPDATE public.submissions
  SET is_winner = (id = p_submission_id)
  WHERE bounty_id = p_bounty_id;

  RETURN chosen_freelancer;
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_bounty_delivery(
  p_bounty_id bigint,
  p_freelancer_id uuid,
  p_delivery_url text
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  changed_project bigint;
  changed_submission uuid;
BEGIN
  UPDATE public.bounties
  SET status = 'review',
      updated_at = now()
  WHERE id = p_bounty_id
    AND winner_id = p_freelancer_id
    AND status = 'in_progress'
  RETURNING id INTO changed_project;

  IF changed_project IS NULL THEN
    RAISE EXCEPTION 'Project is not assigned to this freelancer or is not in progress.';
  END IF;

  UPDATE public.submissions
  SET delivery_url = p_delivery_url,
      revision_note = NULL
  WHERE bounty_id = p_bounty_id
    AND freelancer_id = p_freelancer_id
    AND is_winner = true
  RETURNING id INTO changed_submission;

  IF changed_submission IS NULL THEN
    RAISE EXCEPTION 'Winning proposal was not found.';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_bounty_revision(
  p_bounty_id bigint,
  p_client_id uuid,
  p_note text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  winning_freelancer uuid;
  changed_submission uuid;
BEGIN
  UPDATE public.bounties
  SET status = 'in_progress',
      updated_at = now()
  WHERE id = p_bounty_id
    AND client_id = p_client_id
    AND status = 'review'
  RETURNING winner_id INTO winning_freelancer;

  IF winning_freelancer IS NULL THEN
    RAISE EXCEPTION 'Project is no longer awaiting review or client does not own it.';
  END IF;

  UPDATE public.submissions
  SET revision_note = p_note
  WHERE bounty_id = p_bounty_id
    AND freelancer_id = winning_freelancer
    AND is_winner = true
  RETURNING id INTO changed_submission;

  IF changed_submission IS NULL THEN
    RAISE EXCEPTION 'Winning proposal was not found.';
  END IF;

  RETURN winning_freelancer;
END;
$function$;

REVOKE ALL ON FUNCTION public.choose_bounty_winner(bigint, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_bounty_delivery(bigint, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_bounty_revision(bigint, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.choose_bounty_winner(bigint, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_bounty_delivery(bigint, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_bounty_revision(bigint, uuid, text) TO service_role;

-- TELEGRAM_BOT_TOKEN and SUPABASE_SERVICE_ROLE_KEY must remain private.
COMMIT;
