'use strict';

// Messaging actions, lifted out of the switch in api/index.js.
//
// The send-cap and contact-resolution helpers stay owned by index.js and arrive through
// deps: they are shared with the chat path, so duplicating them here would let the two
// copies drift on a limit that exists to stop the agent messaging people repeatedly.

async function sendMessage({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, checkMillieSendCap, looksLikeMessageAddress, resolveNativeMessageContact } = deps;
  const contact = String(params?.contact || '').trim();
  const message = String(params?.message || '').trim();
  if (!contact || !message) return { success: false, error: 'send_message requires contact and message' };

  // Easy WhatsApp handoff — prefilled, just tap. Doesn't target a specific number (WhatsApp's
  // own compose UI handles recipient selection), so no contact resolution/ambiguity check applies.
  if (params?.platform === 'whatsapp' || action === 'whatsapp') {
    return {
      success: false,
      outcome: 'handoff_required',
      handoffRequired: true,
      text: `Opening WhatsApp for ${contact}.`,
      deepLink: `https://wa.me/?text=${encodeURIComponent(message)}`,
      cardText: message.slice(0, 60)
    };
  }

  const resolvedContact = resolveNativeMessageContact(contact, context.nativeHints);
  if (resolvedContact.ambiguous) {
    return {
      success: false,
      error: `I found more than one ${contact} in your contacts — ${resolvedContact.candidates.join(' or ')}? Tell me which one.`
    };
  }
  if (!resolvedContact.value) {
    return {
      success: false,
      error: `I need a phone number for ${contact}. Turn on Contacts access for Milgrain or include the number.`
    };
  }
  return {
    success: false,
    outcome: 'awaiting_user',
    pending: true,
    text: `Message ready for ${resolvedContact.label}. Review and tap Send.`,
    cardText: `To ${resolvedContact.label} · ${message}`,
    actionSummary: 'Message ready',
    deepLink: `sms:${encodeURIComponent(resolvedContact.value)}?&body=${encodeURIComponent(message)}`
  };
}

async function sendMillieEmail({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, checkMillieSendCap, looksLikeMessageAddress, resolveNativeMessageContact } = deps;
  const to = String(params?.to || '').trim();
  const body = String(params?.body || '').trim();
  if (!to || !body) return { success: false, error: 'send_millie_email requires a recipient and a message' };
  if (!/[^\s<]+@[^\s>]+\.[^\s>]+/.test(to)) {
    return { success: false, error: `I need ${to}'s email address — that doesn't look like one.` };
  }

  const { ensureMillieIdentity, getActiveHandle } = require('../services/millie-identity');
  const { findOrCreateParticipant } = require('../services/participants');
  const { getOrCreateConversation, appendEvent } = require('../services/external-conversations');
  const { sendMillieEmail } = require('../../connectors/millie-email-resend');

  const cap = await checkMillieSendCap(userId, 'email');
  if (!cap.allowed) return { success: false, error: cap.message };

  const { identity, handles } = await ensureMillieIdentity(supabase, userId, { attemptPhone: false });
  const emailHandle = handles.find(h => h.channel_type === 'email') || await getActiveHandle(supabase, userId, 'email');
  if (!emailHandle) return { success: false, error: 'Millie does not have an email address set up yet.' };

  const { participant, address } = await findOrCreateParticipant(supabase, userId, {
    displayName: to, channelType: 'email', addressValue: to
  });
  const requestTaskId = params?.request_task_id || null;
  const { conversation } = await getOrCreateConversation(supabase, {
    userId, millieIdentityId: identity.id, participantId: participant.id, requestTaskId
  });

  const subject = String(params?.subject || '').trim() || 'A message from Millie';

  // Attachments are resolved by document id only — never by filename. See
  // document-attachments.js for why: a fuzzy name match is one step from emailing
  // someone's passport to a stranger. A document pinned to a different workflow is
  // refused unless this turn says otherwise.
  const { resolveAttachmentsForSend } = require('../services/document-attachments');
  let attachments = [];
  let attachedDocuments = [];
  try {
    const resolved = await resolveAttachmentsForSend(supabase, userId, {
      documentIds: params?.attach_document_ids || [],
      requestTaskId,
      allowCrossWorkflow: params?.allow_cross_workflow === true
    });
    attachments = resolved.attachments;
    attachedDocuments = resolved.documents;
  } catch (err) {
    return { success: false, error: err.message };
  }

  let sendResult;
  try {
    sendResult = await sendMillieEmail({ from: emailHandle.handle_value, to, subject, body, attachments });
  } catch (err) {
    return { success: false, error: `Couldn't send that: ${err.message}` };
  }

  await appendEvent(supabase, {
    conversationId: conversation.id,
    channelType: 'email',
    direction: 'outbound',
    participantAddressId: address.id,
    millieIdentityHandleId: emailHandle.id,
    providerEventId: sendResult.providerMessageId,
    subject,
    body
  });

  const attachmentNames = attachedDocuments.map(d => d.filename);
  return {
    success: true,
    text: attachmentNames.length
      ? `Sent to ${to} from Millie's email, with ${attachmentNames.join(', ')}.`
      : `Sent to ${to} from Millie's email.`,
    // Every filename is named on the card: the review gate is the last place a wrong
    // attachment can be caught by a human, so it must not be summarised away.
    cardText: `To ${to} · ${body}${attachmentNames.length ? ` · Attaching: ${attachmentNames.join(', ')}` : ''}`,
    actionSummary: 'Message sent',
    conversationId: conversation.id
  };
}

async function sendMillieSms({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, checkMillieSendCap, looksLikeMessageAddress, resolveNativeMessageContact } = deps;
  const to = String(params?.to || '').trim();
  const body = String(params?.body || '').trim();
  if (!to || !body) return { success: false, error: 'send_millie_sms requires a recipient phone number and a message' };
  if (!looksLikeMessageAddress(to)) {
    return { success: false, error: `I need a phone number for ${to} — that doesn't look like one.` };
  }

  const { ensureMillieIdentity, getActiveHandle } = require('../services/millie-identity');
  const { findOrCreateParticipant } = require('../services/participants');
  const { getOrCreateConversation, appendEvent } = require('../services/external-conversations');
  const { sendSms } = require('../../connectors/phone-provider');

  const cap = await checkMillieSendCap(userId, 'phone_sms');
  if (!cap.allowed) return { success: false, error: cap.message };

  const { identity } = await ensureMillieIdentity(supabase, userId, { attemptPhone: false });
  const phoneHandle = await getActiveHandle(supabase, userId, 'phone_sms');
  if (!phoneHandle) return { success: false, error: 'Millie does not have a phone number set up yet.' };

  const { participant, address } = await findOrCreateParticipant(supabase, userId, {
    displayName: to, channelType: 'phone_sms', addressValue: to
  });
  const requestTaskId = params?.request_task_id || null;
  const { conversation } = await getOrCreateConversation(supabase, {
    userId, millieIdentityId: identity.id, participantId: participant.id, requestTaskId
  });

  let sendResult;
  try {
    // Driven by the provider that issued this number, not by whatever
    // MILLIE_PHONE_PROVIDER currently says.
    sendResult = await sendSms({ from: phoneHandle.handle_value, to, body, provider: phoneHandle.provider });
  } catch (err) {
    return { success: false, error: `Couldn't send that: ${err.message}` };
  }

  await appendEvent(supabase, {
    conversationId: conversation.id,
    channelType: 'phone_sms',
    direction: 'outbound',
    participantAddressId: address.id,
    millieIdentityHandleId: phoneHandle.id,
    providerEventId: sendResult.providerMessageId,
    body
  });

  return {
    success: true,
    text: `Sent to ${to} from Millie's number.`,
    cardText: `To ${to} · ${body}`,
    actionSummary: 'Message sent',
    conversationId: conversation.id
  };
}

async function makeCall({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, checkMillieSendCap, looksLikeMessageAddress, resolveNativeMessageContact } = deps;
  const contact = String(params?.contact || '').trim();
  if (!contact) return { success: false, error: 'make_call requires a contact' };
  return {
    success: false,
    outcome: 'handoff_required',
    handoffRequired: true,
    text: `Opening FaceTime for ${contact}.`,
    deepLink: `facetime://${encodeURIComponent(contact)}`
  };
}

module.exports = {
  handlers: {
    send_message: sendMessage,
    send_millie_email: sendMillieEmail,
    send_millie_sms: sendMillieSms,
    make_call: makeCall
  }
};
