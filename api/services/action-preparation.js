'use strict';

const { buildCalendarReadAction, calendarIntentKind } = require('./calendar-intent');
const { adaptActionForChannel } = require('./chat-channel');

function prepareActionForExecution(action, context = {}) {
  const prepared = adaptActionForChannel(action, context);
  if (prepared?.type !== 'create_calendar_event') return prepared;
  // Only a message that plainly asks to LOOK at the calendar turns a write into a read. With no
  // message (a background run) or an unrelated one ("yes" approving it), the review gate decides.
  if (calendarIntentKind(context.userMessage) !== 'read') return prepared;

  const readAction = buildCalendarReadAction(context.userMessage).actions[0];
  return { ...readAction, _reroutedFrom: prepared.type };
}

module.exports = { prepareActionForExecution };
