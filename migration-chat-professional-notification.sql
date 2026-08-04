-- Post → professional notification: system "עדכונים על פוסטים רלוונטים" messages.
-- Flags a chat message as an automated professional-type notification (as opposed
-- to a regular user-to-user post share) so the client can show a "פנייה למפרסם"
-- contact button only on these messages.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_professional_notification BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN chat_messages.is_professional_notification IS 'True for system-sent "עדכונים על פוסטים רלוונטים" post notifications to matching professionals; enables the in-bubble contact-poster button. False for normal shares/messages.';
