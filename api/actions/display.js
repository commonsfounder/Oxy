'use strict';

// Display and visual-generation actions, lifted out of the switch in api/index.js.
//
// generateImage stays owned by index.js and arrives through deps: it is the outermost
// model/image boundary and belongs bound in one place.

async function listPairedDisplays({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, generateImage } = deps;
  const pairedDisplays = require('../services/paired-displays');
  const displays = await pairedDisplays.listDisplays(supabase, userId);
  return {
    success: true,
    displays,
    text: displays.length
      ? displays.map(display => display.name + ' (' + display.type + ')').join('\n')
      : 'No nearby displays are paired yet.'
  };
}

async function renderToDisplay({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, generateImage } = deps;
  const pairedDisplays = require('../services/paired-displays');
  const event = await pairedDisplays.queueRender(supabase, userId, {
    displayId: params?.display_id || params?.displayId,
    title: params?.title,
    body: params?.body,
    kind: params?.kind
  });
  return {
    // The server has queued the event; the display still has to poll and acknowledge
    // it. Do not claim that a physical screen rendered anything until that boundary is
    // observed.
    success: false,
    outcome: 'incomplete',
    incomplete: true,
    eventId: event.id,
    displayId: event.displayId,
    text: 'Queued for the paired display: ' + event.title,
    actionSummary: 'Queued for display'
  };
}

async function generateVisual({ userId, action, params, enrichedParams, context, deps, helpers }) {
  const { supabase, generateImage } = deps;
  const brief = params?.brief || params?.prompt || params?.topic;
  if (!brief) return { success: false, error: 'generate_visual needs a brief.' };
  const prompt = [
    brief,
    params?.style ? `Style: ${params.style}` : '',
    params?.usage ? `Usage: ${params.usage}` : ''
  ].filter(Boolean).join('\n');
  const visual = await generateImage(prompt, context.imageFile || null);
  return {
    success: true,
    text: visual.text || 'I made a visual for this.',
    artifact: {
      type: 'image',
      title: params?.usage || 'Generated visual',
      image: visual.image,
      mimeType: visual.mimeType
    }
  };
}

async function createDiagram({ params, context, deps }) {
  return deps.createDiagramArtifact(params || {}, context.imageFile || null);
}

async function createPresentation({ params, context, deps }) {
  return deps.createPresentationArtifact(params || {}, context.imageFile || null);
}

module.exports = {
  handlers: {
    create_diagram: createDiagram,
    create_presentation: createPresentation,
    list_paired_displays: listPairedDisplays,
    render_to_display: renderToDisplay,
    generate_visual: generateVisual
  }
};
