-- Adds the 'action_required' category for failed actions that need the user themselves
-- (reconnect a connector, sign in again) rather than a retry Adam can do on its own.
alter table notification_events drop constraint if exists notification_events_category_check;
alter table notification_events add constraint notification_events_category_check
  check (category in ('watch', 'digest', 'delivery', 'reply_needed', 'occasion', 'commitment', 'action_required', 'other'));
