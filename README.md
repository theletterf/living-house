# Living House

An experiment in adaptive UI: a small language model, running entirely in your browser,
watches how you use a web app and reshapes the interface as you go.

The app being adapted is "Hearth", a smart-home app with rooms, lights, blinds,
thermostats, locks and scenes. As you use it (clicking, adjusting, hesitating, selecting
text), the model rewrites wording, restyles anything with CSS, adds hints, reorders
controls and pins shortcuts, trying to make what you need easier to reach. You can also
ask it for changes directly.

A second app, "Atrium", is a workspace tool with deliberately vague labels (invoices hide
under *Account → Statements*), useful for testing whether the model fixes confusing
wording.

The name is a nod to the Oldest House from Remedy's *Control*: a building that
rearranges itself around whoever walks its halls. Here the building is a web app.

## Inspiration

The project started from Simon Edwardsson's
[WorldTUI: I trained a 360M model to pretend to be a terminal](https://simedw.com/2026/10/21/world-model-terminal/),
where a small model predicts how a terminal screen changes with each keypress, with no
shell behind it:

> What I really wanted to know was whether it could maintain a consistent world, or just
> generate convincing terminal output.

Living House asks a related question of interfaces: instead of imitating a fixed world,
can a small model reshape one, in real time, around the person using it?

## Requirements

- A browser with WebGPU: a recent Chrome or Edge.
- Any static file server. There is no build step and no dependencies to install; the
  model runtime ([WebLLM](https://github.com/mlc-ai/web-llm)) loads from a CDN.
  Runtime and model files require downloads on first use. Inference, prompts,
  interaction data and performance measurements stay in the browser. There is no
  remote inference service or telemetry.

## Run

```sh
git clone git@github.com:theletterf/living-house.git
cd living-house
python3 -m http.server 8642
```

Open http://localhost:8642.

1. **Pick a model**: Qwen2.5 (0.5B, 1.5B, 3B), Qwen3 (1.7B, 4B, run with thinking off)
   or Llama 3.2 3B. The download starts right away (from several hundred MB to a few GB
   the first time, cached by the browser after that). Qwen2.5 1.5B is the smallest that
   works well: on an M-series laptop a round takes about 4–6 s and it handled all
   requests in testing. 3B and 4B models need more memory and should do better.
2. **Edit the prompt** (optional). Choose the app to adapt (smart home or workspace) and
   edit the base prompt. Below it you choose which kinds of change the model may make,
   which signals it observes, the timing thresholds and the temperature. "Full prompt
   sent to the model" previews the exact system prompt.
3. **Start.** A training-mode notice explains that the app will adapt; nothing adapts
   until it is closed.

## Using it

### Asking for changes

- **Right-click any element** (a button, a heading, a row, the sidebar, the whole app) to
  open a *Change this* popover anchored to it, and type what should change: "make it
  bigger", "call it Lights", "highlight this".
- **The ask bar** above the app (⌘K / Ctrl+K) takes requests that aren't about one element:
  "warmer colors", "I never use the garage door".

Clear commands such as "Rename Overview to Home" run without model inference.
A page name is shared by its heading, navigation label and help references. Renaming
either the heading or navigation updates all three. Undo restores them together.
If a name matches unrelated elements, choose the target from the displayed buttons.
Right-click commands also support "call it Lights", "make it bigger", "highlight this",
"make it red", "put it first", and "pin this".

Other requests use one model call. They show whether they are waiting or processing.
A newer request replaces an unfinished older request. Requests skip the confirmation
step and report the edits applied, with an *Undo* button. A targeted request cannot
edit another element. The complete plan must pass validation before any edit applies.
General model requests can still misunderstand an instruction; inspect the reported
edits and use Undo if needed.

Requested names are protected from later automatic renames. Repeating a completed
direct command reports success without adding a change. Requests override the soft
limits (locked elements, per-element caps, intensity), but preserve validity and safety
checks. Completed requests become standing preferences for later automatic rounds.
Requests work even with adaptation paused.

### The panel

The panel on the right controls the session:

- **Edit prompt** reopens the setup mid-session. Each applied setup gets a version
  number, logged with every round and change, so you can compare their effect.
- **Adapt the UI** pauses or resumes adaptation. Activity is still logged while paused.
- **Ask before each change** (on by default): each proposed change appears as a small
  popover next to the element it affects, with the model's reason. *Apply* makes the
  change; *Not now* skips it. Declines are shown to the model and the identical change is
  refused afterwards, but nothing is locked. At most 3 proposals wait at once; older
  unanswered ones expire.
- **Intensity** sets how eagerly the UI changes:
  - *Gentle*: after a 2.5 s pause, at most every 12 s, 1 change, only when you seem stuck.
  - *Balanced*: after a 1.2 s pause, at most every 5 s, 1 change.
  - *Max* (default): considers a change immediately when activity supplies evidence.
  - *Extreme*: seeks 1 useful improvement after each click, control change,
    page change, hesitation, text selection, reading event or help interaction.
    It does not wait for repeated activity. It can clarify labels, add hints, improve
    styles, reorder controls or pin actions on the current page and latest target.
    Each element allows up to 100 changes per session. Ordinary hovering does not
    trigger rounds. Interactions during inference are combined into the next round;
    same-page activity does not discard the current result.

  Gentle, Balanced and Max require repeated hesitation, repeated use, several page changes without
  an action, or looking up a control after hesitation. Reading and a single pause do
  not trigger changes. The model may return no changes. Automatic rounds and model
  requests do not retry. Repeated use can move or pin a control. Difficulty can
  trigger a clearer label or hint. These three levels require a direct request for
  style changes. Extreme also permits useful style changes automatically.

  Extreme keeps confirmation, Undo, requested-name protection, enabled operation
  settings and validation. It can return no changes when no useful edit is available.
  It does not run continuously without new interaction. Events within 200 ms are
  combined. Only one model call runs at a time. Automatic inference pauses when
  three changes are waiting for confirmation or safe application.

  The 0.5B model cannot rename elements automatically. Direct rename commands still
  work. Automatic style changes use moderate text sizes, weights, line heights,
  padding or light highlights. Requests can still use the full supported style set.
- **End session** stops adapting and shows a summary: how long the session lasted, how
  many changes were kept or undone, your requests, how many suggestions you accepted or
  declined, what you did, and every change grouped by page. From there you can start a
  new session, keep the adapted layout, export the log, or resume adapting.
- **Start over** returns to the starting layout as a fresh visit. It locks nothing and
  isn't recorded as a rejection; the model just stops seeing earlier activity.

### When a session ends

Ending is always your call, but the house notices when adapting has stopped paying off
and offers to end with a small popover:

- **Its suggestions stop landing**: 4 of the last 5 were declined, undone or left to
  expire.
- **The friction is gone**: 3 minutes of real use (at least 10 actions) with no hesitation
  and no searching around (three page changes in a row without doing anything), once the
  house has changed something.

*Keep going* restarts the detector from that moment, so it doesn't nag. Both the
suggestion and the friction-free time can be changed in the setup.

### Live help

An adaptive UI sounds impossible to document: every person's layout ends up different.
Living House documents it anyway, because every element has a permanent ID that the model
can't change. It can change an element's text, look and place, never its identity (the
output schema only accepts existing IDs, and nothing can create or delete elements).

*Help* in the ask bar opens articles written against those IDs, not against labels or
screenshots:

```
On {{nav_overview}}, choose {{sc_movie}}. It switches off {{lr_ceiling}}, …
```

renders, for someone who asked to rename the ceiling light, as:

> On **Overview**, choose **Movie night**. It switches off **Main light** (formerly
> "Ceiling"), …

- Every name is a *Show me* link: it goes to the right page and spotlights the element,
  instead of a screenshot that would never match.
- `{{value:id}}` shows live state ("The door is **Locked** right now"), and paragraphs
  starting with `{{if pinned:id}}` or `{{unless pinned:id}}` only show when that holds,
  so advice follows the layout.
- Search matches every name an element has had: "Ceiling" still finds the article, and
  says it's now called "Main light".
- *All controls* is a reference generated from the registry: every control, what it
  does, its current name and state, and whether it's pinned.
- Articles are checked against the registry when the app loads; a reference to an
  element that doesn't exist is reported as an error.
- Help use feeds back into adaptation. Looking up a control after hesitation can
  trigger adaptation. Help use also counts as friction for the settled detector.

### Keeping the layout

*Keep this layout* in the summary saves how the app differs from the original (texts,
styles, hints, order, pins; not device states) in the browser. Next time, the setup
offers to start from the kept layout or the original, or to forget it. New sessions and
*Start over* begin from whichever you chose, and adaptation continues from there: a
training period first, then a house that has learned you.
- **Changes** lists every applied change with its reason and an *Undo* button. Undo
  restores the change and locks that element so the model leaves it alone.
- **Activity** shows the signals, model rounds and decisions as they happen.

### Signals

Clicks and control changes (switches, sliders, steppers), page changes, hovering over controls, hesitating on a control (1.5 s) or on a
page (3 s), selecting text, and pointing at text (0.6 s). A pause alone is not treated
as confusion. Every signal can be switched off and every threshold changed in the setup.

### What the model can change

| Change | Applies to |
|---|---|
| Text | Any element with text: buttons, nav items, headings, intro lines, list rows, the brand |
| Style | Any element: one CSS property from a list of 24 (font size and weight, colors, borders, radius, spacing, shadow, opacity, display, transform…) and its value |
| Hint | A one-line note under a control |
| Move first | A control, to the front of its toolbar or the sidebar |
| Pin | An action or a switch, to the Quick actions bar shown on every page |

## How it works

| File | Role |
|---|---|
| `index.html` | Setup, ask bar, app stage, popovers, training-mode notice, session summary, panel |
| `scenarios.js` | The apps that can be adapted, as plain data: pages, rows and controls |
| `docs.js` | Help articles for each app, written as templates against element IDs |
| `app.js` | Element registry, rendering, signal logging, requests, validation, applying and undoing changes, session summary |
| `adapters.js` | Worker model loading, prompt building, JSON-schema-constrained decoding |
| `model-worker.js` | Local browser worker for model inference |
| `dom.js` | Update changed DOM nodes while preserving controls and focus |
| `performance.js` | Local performance aggregates |
| `requests.js` | Direct command parsing, target resolution, evidence for automatic changes |
| `styles.css` | Styles (light theme only) |

- Inference runs in a dedicated Web Worker, separate from the interface thread.
  Worker failures are reported, and unloading a model terminates its worker.
- The app updates existing DOM nodes. It preserves control identity and uncommitted
  slider values during unrelated updates. Activity updates are combined per frame.
- Every element has an id. Each round, the model gets a list of the elements (with their
  text, purpose, current state, custom style and usage stats), the recent activity and
  the person's standing requests, and answers in JSON.
- Adding an app means adding a scenario to `scenarios.js`: pages with an intro line and
  list rows, and controls of kind `nav`, `action`, `toggle`, `slider` or `stepper`.
- Decoding is constrained by a JSON schema with one shape per change type: each limits
  `id` to the kinds of element it applies to (text only where there is text, pins only
  on actions and switches), and a restyle picks its property from a fixed list. Small
  models got the old shared `text` field wrong (labels sent as CSS, empty styles). The
  schema doesn't depend on what is locked or pinned, so WebLLM can reuse its compiled
  grammar between rounds.
- Automatic rounds send at most six relevant targets in Extreme mode and the
  evidence target in other modes. They request one edit per round. The schema uses
  stable IDs for the whole scenario, so changing pages does not change its ID list.
  Recent activity and completed changes give context without sending the full UI.
- Every proposal is validated before it's applied. Style changes are checked with
  `CSS.supports`, and values that would load anything from outside (`url()`, `@import`,
  …) are refused.
- The app is CSS-contained in its stage, so even `position: fixed` or a huge `z-index`
  can't cover the panel: Undo and Start over always stay reachable.
- Changes wait while the pointer is over a toolbar they could shift, and text selections
  survive re-renders.

## Data

*Export log* downloads a JSONL file with every event (including each setup version with
its full prompt), every change, and each round's raw model output and rejected changes.
Request rounds also record queue, inference and apply times. Automatic rounds
record queue, preparation, inference and validation times. The export includes
aggregate render times and long browser tasks where the browser supports them.
These measurements stay local and do not include network telemetry.
The idea is to use these logs to train a small model on the changes that actually
helped.

## Checks

Run `node --test *.test.mjs` to check direct requests, background scheduling,
validation, Undo, DOM updates and worker error handling without downloading a model.
These tests do not measure real GPU inference speed or browser layout.

## License

[MIT](LICENSE)
