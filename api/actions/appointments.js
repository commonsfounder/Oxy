'use strict';

// Appointment actions, lifted out of the switch in api/index.js.
//
// The booking-service accessor and the task helpers stay owned by index.js: they are also
// used by the chat path that infers a booking turn, and two copies would drift.

async function findAppointmentOptions({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { getAppointmentBookingService, appointmentChoicesText, saveAppointmentTask, delegatedRunLifecycle } = deps;
  const request = String(params?.request || '').trim();
  const service = getAppointmentBookingService();
  if (!service) {
    const booking = { request, service: 'appointment', preference: { label: '' }, choices: [], phase: 'needs_connection' };
    const task = await saveAppointmentTask(userId, params?.task_id, booking, { lastError: 'Appointment booking is not connected yet.' });
    return {
      success: false,
      error: "Connect appointment booking to continue.",
      taskId: task.id,
      actionSummary: 'Appointment saved'
    };
  }
  try {
    const found = await service.findChoices({
      request,
      calendarEvents: Array.isArray(context.appointmentCalendarEvents) ? context.appointmentCalendarEvents : []
    });
    if (found.kind === 'missing_details') {
      return { success: true, text: found.text, actionSummary: 'Appointment details needed' };
    }
    const booking = {
      request,
      service: found.service || 'appointment',
      preference: found.preference || { label: '' },
      provider: found.provider || 'sandbox',
      choices: found.choices || [],
      phase: found.ok ? 'choosing' : 'no_choices'
    };
    const task = await saveAppointmentTask(userId, params?.task_id, booking, { lastError: found.ok ? null : found.text });
    if (!found.ok) return { success: false, error: found.text, taskId: task.id, actionSummary: 'Appointment search paused' };
    return {
      success: true,
      text: appointmentChoicesText(found.service, found.choices),
      cardText: found.choices.map(choice => choice.label).join('\n'),
      actionSummary: 'Appointment options found',
      taskId: task.id,
      choices: found.choices
    };
  } catch {
    const booking = { request, service: 'appointment', preference: { label: '' }, choices: [], phase: 'paused' };
    const task = await saveAppointmentTask(userId, params?.task_id, booking, { lastError: 'Appointment search paused.' });
    return { success: false, error: "Couldn't find appointment times. Try again.", taskId: task.id };
  }
}

async function bookAppointment({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { getAppointmentBookingService, appointmentChoicesText, saveAppointmentTask, delegatedRunLifecycle } = deps;
  const task = await delegatedRunLifecycle.get(userId, params?.task_id);
  const booking = task?.metadata?.appointmentBooking;
  const choice = booking?.choices?.find(item => item.id === params?.choice_id);
  if (!task || !booking || !choice) return { success: false, error: "I couldn't find that appointment choice. Please ask me to look again." };
  const service = getAppointmentBookingService();
  if (!service || booking.provider !== 'sandbox') {
    await saveAppointmentTask(userId, task.id, { ...booking, phase: 'needs_connection' }, { lastError: 'Appointment booking is not connected yet.' });
    return { success: false, error: 'Appointment booking is not connected yet.' };
  }
  try {
    const committed = booking.phase === 'calendar_retry' && booking.booking
      ? await service.addBookingToCalendar({ booking: booking.booking })
      : await service.commitChoice({ choice, approved: true });
    if (!committed.ok) {
      await saveAppointmentTask(userId, task.id, { ...booking, phase: committed.kind === 'calendar_failed' ? 'calendar_retry' : 'choosing', booking: committed.booking || null }, {
        lastError: committed.text || 'Appointment was not confirmed.'
      });
      return { success: false, error: committed.text || "Couldn't confirm that appointment." };
    }
    const completedBooking = { ...booking, phase: 'confirmed', booking: committed.booking };
    await saveAppointmentTask(userId, task.id, completedBooking, {
      status: 'completed',
      checkpoint: false,
      completedAt: new Date().toISOString(),
      results: [{ action: 'book_appointment', result: { success: true, actionSummary: 'Appointment confirmed', text: `Booked ${choice.service} appointment for ${choice.label}.` } }]
    });
    return {
      success: true,
      text: `Booked your ${choice.service} appointment for ${choice.label} and added it to your calendar.`,
      cardText: choice.label,
      actionSummary: 'Appointment confirmed',
      taskId: task.id
    };
  } catch {
    await saveAppointmentTask(userId, task.id, { ...booking, phase: 'choosing' }, { lastError: 'Appointment booking paused.' });
    return { success: false, error: "Couldn't confirm that appointment. Try again." };
  }
}

module.exports = {
  handlers: {
    find_appointment_options: findAppointmentOptions,
    book_appointment: bookAppointment
  }
};
