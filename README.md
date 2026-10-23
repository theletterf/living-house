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

## Run

```sh
git clone git@github.com:theletterf/living-house.git
cd living-house
python3 -m http.server 8642
```

Open http://localhost:8642.

1. **Pick a model**: Qwen2.5 0.5B or 1.5B Instruct. The download starts right away
   (several hundred MB the first time, cached by the browser after that). 1.5B gives
   noticeably better changes.
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

Requests apply immediately, without the confirmation step, and reply in one line with an
*Undo*. If the model can't do something with the changes it's allowed to make, it says so
instead of making an unrelated change. Requests override the soft limits (locked
elements, per-element caps, intensity) but never the validity and safety checks. Every
request stays in the prompt as a standing preference for the rest of the session, and
requests work even with adaptation paused.

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
  - *Balanced*: after a 1.2 s pause, at most every 5 s, up to 2 changes.
  - *Max* (default): every action starts a round right away, and the model must propose
    at least one change. If all its proposals are rejected, it is asked once more with
    the reasons.
- **End session** stops adapting and shows a summary: how long the session lasted, how
  many changes were kept or undone, your requests, how many suggestions you accepted or
  declined, what you did, and every change grouped by page. From there you can start a
  new session, keep the adapted layout, export the log, or resume adapting.
- **Start over** restores the original app as a fresh visit. It locks nothing and isn't
  recorded as a rejection; the model just stops seeing earlier activity.
- **Changes** lists every applied change with its reason and an *Undo* button. Undo
  restores the change and locks that element so the model leaves it alone.
- **Activity** shows the signals, model rounds and decisions as they happen.

### Signals

Clicks and control changes (switches, sliders, steppers), page changes, hovering over controls, hesitating on a control (1.5 s) or on a
page (3 s), selecting text, and pointing at text (0.6 s). Hesitation is read as
confusion. Every signal can be switched off and every threshold changed in the setup.

### What the model can change

| Change | Applies to |
|---|---|
| Text | Any element with text: buttons, nav items, headings, intro lines, list rows, the brand |
| Style | Any element, any CSS: colors, borders, radius, spacing, fonts, shadows… |
| Hint | A one-line note under a control |
| Move first | A control, to the front of its toolbar or the sidebar |
| Pin | An action or a switch, to the Quick actions bar shown on every page |

## How it works

| File | Role |
|---|---|
| `index.html` | Setup, ask bar, app stage, popovers, training-mode notice, session summary, panel |
| `scenarios.js` | The apps that can be adapted, as plain data: pages, rows and controls |
| `app.js` | Element registry, rendering, signal logging, requests, validation, applying and undoing changes, session summary |
| `adapters.js` | Model loading, prompt building, JSON-schema-constrained decoding |
| `styles.css` | Styles (light theme only) |

- Every element has an id. Each round, the model gets a list of the elements (with their
  text, purpose, current state, custom style and usage stats), the recent activity and
  the person's standing requests, and answers in JSON.
- Adding an app means adding a scenario to `scenarios.js`: pages with an intro line and
  list rows, and controls of kind `nav`, `action`, `toggle`, `slider` or `stepper`.
- Decoding is constrained by a JSON schema whose `op` and `id` fields are enums, so the
  model can only emit enabled change types on elements that exist.
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
The idea is to use these logs to train a small model on the changes that actually
helped.

## License

[MIT](LICENSE)
