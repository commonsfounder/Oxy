'use strict';

const { buildCalendarReadAction, calendarIntentKind } = require('./calendar-intent');
const { adaptActionForChannel } = require('./chat-channel');

function prepareActionForExecution(action, context = {}) {
  const prepared = adaptActionForChannel(action, context);
  if (prepared?.type !== 'create_calendar_event') return prepared;
  if (calendarIntentKind(context.userMessage) === 'write') return prepared;

  const readAction = buildCalendarReadAction(context.userMessage).actions[0];
  return { ...readAction, _reroutedFrom: prepared.type };
}

module.exports = { prepareActionForExecution };
