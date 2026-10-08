# Interfaces in the conversation

Adam uses the existing `show_scene` capability to compose an interface for the current decision. It does not select a separate task agent or route based on shopping, travel, forms or another domain.

An interactive scene has `mode: "interface"` and a sequence of checked panel blocks. The iOS thread renders the data with native controls; a deterministic offline HTML renderer serves older clients and paired displays. Original narrated scenes continue to open as explainers.

```json
{
  "title": "Choose a time",
  "mode": "interface",
  "panel": [
    {
      "id": "times",
      "type": "choices",
      "items": [
        { "title": "Morning", "ask": "Find a morning appointment" },
        { "title": "Afternoon", "ask": "Find an afternoon appointment" }
      ]
    }
  ]
}
```

Supported blocks are text, number, bars, timeline, steps, compare, choices, table and form. Adam chooses the blocks, their order and their content from the current conversation and observed results. The renderer owns typography, spacing, control behavior and accessibility. This is composition from supported primitives, not arbitrary model-authored executable UI.

Choosing an option or submitting a form creates an ordinary user turn in the same chat. The iOS request carries `interactionOrigin: "task_interface"`, retained through queues and retries. The server rejects approval/cancellation language and review identifiers from that source before looking up pending approvals. Consequential actions still use the existing execution boundary and dedicated review controls. Forms collect bounded ordinary details, with required and numeric validation; passwords, card details and other secrets use the existing protected flows.

Checklist checks and form values are local drafts. They do not perform actions, establish completion or survive an app restart. Sharing progress tells Adam what the user checked. A follow-up can produce a different interface in a subsequent turn; this version does not mutate earlier messages or stream live values into an existing interface. Maps and existing native travel results retain their current renderers.

Verification:

- `node --test test/smoke/task-interface.test.js test/smoke/paired-display-routes.test.js`
- `node test/dev/scene-eval.js /private/tmp/adam-task-ui-eval` calls the configured real model, validates each result and saves native action payloads plus HTML. The cases cover comparisons, checklists, forms and legacy explainers; they do not prove autonomous selection in a deployed `/chat` session.
- Debug simulator preview: `OXY_DEBUG_AUTOLOGIN=1 OXY_DEBUG_MESSAGES=1 OXY_DEBUG_SCENE_FILE=/private/tmp/adam-task-ui-eval/comparison.action.json`. `OXY_DEBUG_SCENE_PROMPT` sets the preview request. Preview values are illustrative, not live quotes or bookings.

Local changes require an app build and a backend deployment before the live chat can produce these interfaces. No deployment is implied by a passing preview or model evaluation.

## Surface design handoff

**Mode: Operate.** This is a local extension of Adam's existing chat. `SceneCard` renders interface blocks inline in the message, with a left-aligned vertical composition and 20-point spacing. Legacy explainers retain their page-opening behavior. This pass adds no assets, design comp, detector or global design-token changes; `DESIGN.md` remains unchanged.

The native surface inherits `AppTheme.swift`: `sectionTitle` for interface and comparison headings, `rowTitle` for choices, field labels and table headers, and `bodyText` for content. These are the existing Fraunces heading and system-body tokens, with their existing text-size scaling. Ink, muted text, accent requests and action-button colors use the incumbent semantic roles. The canvas follows the user's Automatic, Warm, Sea or Night background selection. Choice/comparison containers and form fields reuse `settingsSurface`: a quiet raised fill, hairline outline and rounded corners, without shadows.

Comparisons keep 238-point columns in a horizontal scroll view; tables keep 126-point text columns and wrap cell content vertically while scrolling horizontally. Forms use native `TextField` and `Button` controls, and checklist rows use native buttons with checked/unchecked accessibility values. Checklist and form state remain local drafts. Request buttons have a 44-point minimum width and height; choice rows, fields, submit buttons and checklist rows have taller minimum targets. On interface messages, the parent row's swipe and long-press gesture masks leave interaction to child controls. The row retains the accessibility **Reply** action.

Reviewer disposition: ship the local implementation for visual/source review. The gesture-ownership and short-target findings are resolved in source. Native interaction remains **unverified**, as detailed below; this disposition does not establish deployed readiness.

## Local verification, 7 October 2026

The configured live model generated a train comparison, packing checklist and appointment form, alongside three legacy scenes. All six validated; the tightened appointment-copy check passed on a subsequent single-case run. The isolated HTML renderer passed real choice clicks, required-field rejection, complete form submission and checked-item reporting, with no browser runtime errors.

The iOS simulator build reported `Build succeeded`. Phone captures cover a dark comparison, light form and large-type checklist; a tablet capture covers the comparison. They are in `.impeccable/review/task-ui/`. The full smoke suite reported `1939 passed, 0 failed, 2 skipped` out of 1941 tests. `check:undef` reported zero errors and one existing unused-directive warning in `api/actions/assistant.js`.

Native pointer input remains unverified: simulator tap/type tools reported success but produced no visible changes or HTTP requests, and Computer Use was not approved for Device Hub. Visual/source review identified parent-row gesture conflicts and undersized short request targets; interface rows now leave pointer gestures to their child controls and request buttons enforce a 44-point minimum in both dimensions. Accessibility Reply remains available. Native scrolling, keyboard behavior, form submission and composer-draft preservation still need actual interaction evidence.

No commit, push, backend deployment or physical-phone installation was performed. Concurrent sound-recognition changes were left with their author.
