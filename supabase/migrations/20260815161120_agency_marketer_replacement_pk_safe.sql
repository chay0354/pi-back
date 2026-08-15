CREATE OR REPLACE FUNCTION public.redeem_agency_marketer_replacement(
  p_code TEXT,
  p_new_email TEXT,
  p_new_name TEXT,
  p_new_password_hash TEXT,
  p_new_phone TEXT DEFAULT NULL
)
RETURNS TABLE (
  target_subscription_id UUID,
  manager_subscription_id UUID,
  previous_email TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_code public.agency_marketer_replacement_codes%ROWTYPE;
  v_target public.subscriptions%ROWTYPE;
  v_email TEXT := LOWER(BTRIM(COALESCE(p_new_email, '')));
  v_name TEXT := NULLIF(BTRIM(COALESCE(p_new_name, '')), '');
  v_phone TEXT := NULLIF(BTRIM(COALESCE(p_new_phone, '')), '');
  v_old_email TEXT;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_EMAIL';
  END IF;

  SELECT *
  INTO v_code
  FROM public.agency_marketer_replacement_codes
  WHERE code = UPPER(BTRIM(COALESCE(p_code, '')))
  FOR UPDATE;

  IF NOT FOUND OR NOT v_code.is_active OR v_code.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REPLACEMENT_CODE_INVALID';
  END IF;
  IF v_code.expires_at <= NOW() THEN
    UPDATE public.agency_marketer_replacement_codes
    SET is_active = FALSE
    WHERE id = v_code.id;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REPLACEMENT_CODE_EXPIRED';
  END IF;

  SELECT *
  INTO v_target
  FROM public.subscriptions
  WHERE id = v_code.target_subscription_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_target.subscription_type <> 'project_marketer'
     OR v_target.parent_subscription_id IS DISTINCT FROM v_code.manager_subscription_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'REPLACEMENT_TARGET_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE LOWER(email) = v_email AND id <> v_target.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'REPLACEMENT_EMAIL_IN_USE';
  END IF;

  v_old_email := LOWER(BTRIM(COALESCE(v_target.email, '')));

  IF v_old_email <> '' AND v_old_email <> v_email THEN
    DELETE FROM public.chat_participants p
    WHERE LOWER(p.user_id) = v_old_email
      AND EXISTS (
        SELECT 1 FROM public.chat_participants x
        WHERE x.conversation_id = p.conversation_id
          AND LOWER(x.user_id) = v_email
      );

    UPDATE public.chat_participants
    SET user_id = v_email,
        display_name = COALESCE(v_name, SPLIT_PART(v_email, '@', 1)),
        profile_picture_url = NULL
    WHERE LOWER(user_id) = v_old_email;

    UPDATE public.chat_messages SET sender_id = v_email
    WHERE LOWER(sender_id) = v_old_email;
    UPDATE public.chat_messages SET receiver_id = v_email
    WHERE LOWER(receiver_id) = v_old_email;
    UPDATE public.chat_conversations SET group_creator_email = v_email
    WHERE LOWER(group_creator_email) = v_old_email;
    UPDATE public.chat_exclusive_offers SET broker_email = v_email
    WHERE LOWER(broker_email) = v_old_email;
    UPDATE public.chat_exclusive_offers SET owner_email = v_email
    WHERE LOWER(owner_email) = v_old_email;
    UPDATE public.ads SET creator_email = v_email
    WHERE LOWER(creator_email) = v_old_email;
    UPDATE public.improvements_feedback SET created_by_email = v_email
    WHERE LOWER(created_by_email) = v_old_email;
    UPDATE public.company_reports SET reporter_email = v_email
    WHERE LOWER(reporter_email) = v_old_email;

    DELETE FROM public.ad_likes a
    WHERE LOWER(a.user_id) = v_old_email
      AND EXISTS (
        SELECT 1 FROM public.ad_likes x
        WHERE x.ad_id = a.ad_id AND LOWER(x.user_id) = v_email
      );
    UPDATE public.ad_likes SET user_id = v_email
    WHERE LOWER(user_id) = v_old_email;

    DELETE FROM public.post_likes a
    WHERE LOWER(a.user_id) = v_old_email
      AND EXISTS (
        SELECT 1 FROM public.post_likes x
        WHERE x.ad_id = a.ad_id AND LOWER(x.user_id) = v_email
      );
    UPDATE public.post_likes SET user_id = v_email
    WHERE LOWER(user_id) = v_old_email;

    UPDATE public.post_comments SET user_id = v_email
    WHERE LOWER(user_id) = v_old_email;

    DELETE FROM public.post_comment_reactions a
    WHERE LOWER(a.user_id) = v_old_email
      AND EXISTS (
        SELECT 1 FROM public.post_comment_reactions x
        WHERE x.comment_id = a.comment_id AND LOWER(x.user_id) = v_email
      );
    UPDATE public.post_comment_reactions SET user_id = v_email
    WHERE LOWER(user_id) = v_old_email;
  END IF;

  UPDATE public.subscriptions
  SET email = v_email,
      name = COALESCE(v_name, SPLIT_PART(v_email, '@', 1)),
      password_hash = p_new_password_hash,
      phone = v_phone,
      mobile_phone = v_phone,
      contact_person_name = COALESCE(v_name, SPLIT_PART(v_email, '@', 1)),
      profile_picture_url = NULL,
      company_logo_url = NULL,
      status = 'verified',
      verified_at = NOW(),
      updated_at = NOW()
  WHERE id = v_target.id;

  UPDATE public.agency_marketer_replacement_codes
  SET is_active = FALSE,
      consumed_at = NOW()
  WHERE id = v_code.id;

  UPDATE public.agency_marketer_replacement_codes
  SET is_active = FALSE
  WHERE target_subscription_id = v_target.id
    AND id <> v_code.id
    AND is_active = TRUE;

  RETURN QUERY
  SELECT v_target.id, v_code.manager_subscription_id, v_old_email;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_agency_marketer_replacement(
  TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_agency_marketer_replacement(
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;
