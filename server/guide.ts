/**
 * The playbook agents load via get_guide, kept out of the initialize instructions so the
 * handshake stays small (Claude Code cuts server instructions at 4,096 characters).
 * As Paper and pen.dev do it: one main guide every agent loads first ("doop-instructions"),
 * and topics an agent loads only when its task needs one, so every session does not pay
 * for the whole playbook.
 */

import { AGENT_ROLES } from '../shared/agents.ts'
import { MAX_DECISION_CHARS } from '../shared/designDecisions.ts'

export const GUIDE_TOPICS = [
  'doop-instructions',
  'design-craft',
  'review-pipeline',
  'specflow-components',
  'gonovus-components',
  'images',
  'components',
  'prototypes',
  'redesigns',
  'comments-and-agents',
  'export',
  'imported-frames',
] as const

export type GuideTopic = (typeof GUIDE_TOPICS)[number]

/** What each topic covers: listed in get_guide's description and at the end of the main guide. */
export const GUIDE_TOPIC_SUMMARIES: Record<GuideTopic, string> = {
  'doop-instructions': 'the main guide: load it first, before any other Doop tool',
  'design-craft': 'clarifying questions, multi-direction exploration with tradeoffs, and anti-AI-slop craft',
  'review-pipeline': 'mandatory 5-role self-review (UX, Copy, Brand, A11y, Polish) + inspect_frame + save_decision',
  'specflow-components': 'authoring real React 19 SpecFlow component frames (get_design_system + create_ds_frame)',
  'gonovus-components':
    'loading GoNovus React 18 UMD bundle (/ds/gonovus/latest, window.GoNovusA) and publishing updates',
  images: 'photos, backgrounds, icons, logos, generated images and uploads in full',
  components: 'nesting, variants, overrides, deleting, other canvases and workspace libraries',
  prototypes: 'wiring screens into a clickable flow',
  redesigns: 'redesigning an existing site or page: import, audit, two directions',
  'comments-and-agents': "comment threads, and the built-in Doop Agent's roles",
  export: 'images and PDF of a frame or one element',
  'imported-frames': 'frames imported from a GitHub repo or synced from a live app',
}

/** The check a frame-writing tool's description asks for, at the moment the HTML is written:
 *  MCP's create_frame, append_frame_html and set_frame_html and the resident's matching tools. */
export const COMPOSE_CHECK =
  "Before you send the HTML, check it against the canvas's component system: is anything here a part of the system you are redrawing (use <doop-use>), or a reusable piece the system should gain (create it first)? One-off layout stays plain HTML."

/** The must-do list at the top of the guide and the resident prompt: how a canvas is set up
 *  before its screens, said first so it is not buried under streaming and images. */
export const SYSTEM_FIRST = `Set up the system, then compose. Work the way a designer sets up a Figma file:

1. **Tokens first.** The brief's colours, type, radii and spacing become the canvas's tokens
   (create_tokens) before the first frame; frames use them as var(--…).
2. **A component system before screens.** Sketch the few primitives a product like this is
   built from (a Button with its variants, inputs, a tag or badge) and the patterns it leans on
   (nav, a card, a list row), and make them components with create_components, on the tokens.
   A button that appears once is still the system's Button. Then compose every screen from
   them with <doop-use>, and grow the system as you go: a reusable piece a screen needs is
   added to the system, not drawn inline. One-off layout (a hero's composition, section
   wrappers, the page grid) stays plain HTML. Ask what a designer would put on the
   Components page.
3. **Themes are tokens.** Dark mode, or any other theme, is set_token_themes and
   data-doop-theme on the frame, never a copied frame with its colours changed.

On a canvas that already has tokens and components, use them: get_canvas lists both.`

/** The taste doctrine every design surface shares. The MCP guide serves it to
 *  external agents and the resident system prompt embeds it verbatim, so the
 *  two cannot drift apart. */
export const DESIGN_QUALITY = `- Commit to ONE clear aesthetic direction per frame and execute it precisely.
  Intentionality beats intensity; a refined minimal frame and a maximal one are both good
  when the choice is deliberate.
- Typography does the heavy lifting: pair a characterful display face with a quiet body
  face, and use strong size contrast between display and label text. Avoid the default
  faces everyone reaches for (Inter, Roboto, Arial) unless the brief wants a system feel.
- Color: before any hex, commit to a MOOD — a physical scene or register (mineral,
  bookish, candlelit, maritime, alpine, industrial, phosphor, signage, gallery …) — and
  derive every color from a specific object in that scene ("bookish" = plaster, oak,
  ink, candle flame). If you cannot name the object behind a color, the palette is
  abstract and will feel glued together. List a few plausible moods, then pick one that
  is NOT your first instinct — first instincts regress to the same predictable answers.
  One ground, ONE strong accent, supporting tones from the same scene.
- Avoid the clichés that read as AI output: purple gradients on white, navy or charcoal
  with electric teal/purple/lime, warm off-white with terracotta or burnt orange, muted
  earth tones on pure white, neon accents on tinted warm grounds, gratuitous
  glassmorphism, shadows on everything.
- White space is a feature. Vary spacing deliberately — tight inside groups, generous
  between them.
- Realistic content everywhere. No lorem ipsum, no "Your text here". When placeholder
  content needs a design tool as an example, it is Doop — never a competitor.
- Logos are real, never placeholders. Every slot that shows a company mark — "trusted by"
  walls, integration and "works with" rows, payment methods, press bars, app-store
  badges, the company beside a testimonial — gets that company's actual logo fetched
  with search_logos (one call per brand, by domain). Choose real, recognizable brands
  that fit the product's audience instead of inventing "Acme" or "Globex". No gray
  tiles, no "LOGO" text, no initials-in-a-circle, no hand-drawn brand marks.`

/** The brief-first ritual with its inspiration-retrieval mandate. Shared by the
 *  MCP guide and the resident system prompt (both toolsets expose
 *  search_inspiration, set_status and save_decision) so the ritual cannot drift. */
export const DESIGN_BRIEF = `Before creating frames on a canvas whose style is not already established, commit to a
brief. It is part of the deliverable, not private scratch work:

1. **Look at real pages first.** Call search_inspiration with the genre plus the look
   you are aiming for, in the words the catalog is tagged with — "saas landing page,
   editorial", "finance, dark minimal", "app, illustrative" — not the product noun on
   its own ("AI meeting notes" matches nothing useful). You SEE real, curated live
   pages as thumbnails, each tagged with its style, colour, fonts and sections; read
   the palette off the thumbnail. Read them like a
   designer reads a moodboard: what carries the hero (product shot, type, illustration,
   photography), how the ground and the one accent are disciplined, how much work the
   type does, how dense the page is. If the set all looks alike, run a second query in a
   different register before deciding. Then pick ONE exemplar — the single page whose
   direction fits the brief best — and follow it. Do not blend several pages into a
   composite: a design that commits to one reference reads as intentional; a mix of
   four reads as generic.
2. **Write the brief**: mood candidates → the mood chosen (not your first instinct,
   and say why) → palette with roles (5–6 hexes) → type (faces, weights, scale) →
   hero device → one-line direction. NAME the one exemplar you are following and say
   why it won — or state that none fit and the brief derives from the design-quality
   principles alone.
3. **Make it the canvas's tokens.** Before your first frame, create the brief's values
   with create_tokens: the palette by role (--color-ground, --color-ink, --color-accent…),
   font families, the type scale, radii and spacing. Frames and components then use them
   as var(--…), and a change to a token restyles every frame that names it. The tokens
   are where the values live; nothing else holds them.
   **Then set up the component system on them.** Name the primitives and patterns the
   design is built from, the way a designer starts a Figma file's Components page (a Button
   with its variants, inputs, a badge; the nav, a card, a list row), and create them in one
   create_components call, primitives first so the patterns can <doop-use> them. The first
   frame is composed from these.
4. **Post it.** Summarize in set_status ("Designing grocery landing — candlelit mood,
   after Oatside") and record the choices that need a reason with save_decision: the
   exemplar you followed and why it won, why this mood, why this accent. A decision is
   the why, not a copy of the values. Each call holds one decision and its rationale, at
   most ${MAX_DECISION_CHARS} characters; do not split sentences into arbitrary chunks or drop the
   rationale to squeeze several decisions into one call.

Skip the brief only when the canvas already dictates the style — tokens (get_tokens),
established frames, style guides or pinned references — or when the human handed you a
complete design system. Then those are the brief; follow them, and if a value you need
has no token yet, add one with create_tokens rather than writing it into a frame. Frames
with no tokens behind them are a brief too: get_canvas's existingStyle lists the colours
and fonts they share, so create those as tokens before your first new frame instead of
copying hex values from page to page. Leave the existing frames as they are unless asked,
and offer to move them onto the tokens when you finish.`

/** How to wire a clickable prototype — shared by the MCP guide and the resident agents' system prompt. */
export const PROTOTYPES = `When a human asks for a clickable prototype or a flow, wire the screens with data attributes on
the element that triggers each step (edit_frame_html is enough; they are inert on the canvas and
only run in the player):

    <button data-doop-on="click" data-doop-action="navigate:<frameId>"
            data-doop-transition="push-left" data-doop-duration="300">Continue</button>

- data-doop-on: click | hover | press (while held) | delay:<ms> (after the screen shows; on any
  element, e.g. <body>) | key:<Key> (KeyboardEvent.key: ArrowRight, Escape, Enter, Space).
- data-doop-action: navigate:<frameId> | back | overlay:<frameId> (opens that frame as a modal
  over a scrim) | close-overlay | scroll-to:<css selector> | url:<https url> (new tab).
- data-doop-transition: instant (default) | dissolve | slide-left | slide-right | slide-up |
  slide-down | push-left | push-right; data-doop-duration in ms (default 300).
- Several interactions on one element: data-doop-interactions='[{"on":"click","action":
  "navigate:abc"},{"on":"key:Escape","action":"back"}]' instead of the single attributes.
- Wire screens only with these attributes: the player does not follow href links or script click
  handlers between frames.
- Use real frame ids from the canvas, never invented ones. Size overlay frames to the modal itself, not the page.
- set_prototype_start picks the frame the flow starts on; get_prototype lists every interaction
  and flags targets that do not exist — call it after wiring and fix what it flags. The player
  lives at /c/<canvasId>/proto (append ?frame=<id> to open on a specific screen).`

/** How to use components — shared by the MCP guide and the resident agents' system prompt. */
/** Where a frame's CSS goes. People edit a frame element by element, and the
 *  editor reads and writes the style attribute, so that is where an agent's
 *  styles are most editable. Guidance only: nothing rejects a stylesheet. */
export const FRAME_STYLES = `- Style an element on the element itself: style="…". People edit a frame element by element in the
  editor, which reads and writes that attribute, so a style written there is one they can change,
  move and copy without surprises. A stylesheet rule can outrank their edit, or stop matching the
  moment they group or reorder layers.
- Colours, fonts, sizes, radii and spacing come from the canvas's design tokens (get_tokens) as
  var(--name), in a style attribute or a rule alike. Never declare your own palette on :root or
  redefine a token in a frame: Doop writes the values a frame names into it, and a local copy stops
  following the canvas. If a value you need has no token, add it with create_tokens instead of
  writing a hex.
- A <style> block is for what an attribute cannot say: @keyframes, @font-face, custom properties
  that are not canvas values, states (:hover, :focus, :active, :disabled, :checked), pseudo-elements (::before,
  ::placeholder), @media and @container queries, a component's variant and state rules, and the
  reset. Keep using it for those: never drop a hover state or an animation to avoid the block.
- A property that changes with a state, a variant or a query goes in the stylesheet in both forms,
  the resting value included. An inline value outranks every rule, so style="background:#111" would
  keep .btn:hover { background:#333 } from ever showing. Only what never changes on the element
  stays inline.
- Set inherited text styles (font-family, color, line-height) once, on the body or a section, not on
  every text element.
- A block you would repeat is a component, not a class (Components, below).
- Do not write !important, least of all to make a rule beat an inline value: move the property into
  the stylesheet as above.
- This is how to write new markup. A frame that already styles itself with classes keeps them: edit
  it in its own idiom, and do not convert it.`

/** What must not ride inside frame HTML. A frame is stored whole, sent whole to
 *  every viewer on each edit and read whole by agents, so a file inlined into it
 *  costs every one of those round-trips. Base64 data: URIs are refused by the
 *  write tools (server/inlineData.ts); the rest is guidance. Shared by the MCP
 *  guide and the resident agents' system prompt. */
export const LEAN_FRAMES = `- Frames carry markup, never files. A frame is sent whole to every viewer and agent on each
  edit, so anything pasted into it is paid for on every round-trip. A base64 data: URI of any
  kind is refused and nothing is written, and so is a long block of base64 text in a script or
  anywhere else (a packed bundle, a compressed data file). Put each heavy thing where it belongs:
  - Fonts: a family the canvas library or the hosted fonts already have is used by name alone.
    Any other font file goes into the library with upload_font, then is named in CSS: never an
    @font-face with the file inlined.
  - Pictures: a URL from search_images, search_icons, search_logos, generate_image or
    upload_asset. A vector is an inline <svg> element, or a URL-encoded data:image/svg+xml,…
    (no base64) for a small CSS background.
  - Large vector art (a traced illustration, a map, a detailed logo, anything over ~20 KB of
    path data): upload the .svg and use it as <img>. Keep inline <svg> for icons and shapes
    someone may want to edit.
  - Video and audio: frames are designs, so show a poster image instead of embedding a clip.
  - Libraries and frameworks (charting, 3D, animation, a CSS framework): load them from a CDN with
    <script src> or <link>, never pasted in. Better still, write only the CSS the design uses.
  - Data: a chart or table needs a few representative rows, not the dataset. Keep inline JSON to a
    few KB.
  - Icon sets: hotlink each icon you use from search_icons, not a sprite sheet of the whole set.
  - An application: a frame is one screen. Never pack an app's bundles and pages into a frame to
    make it clickable; put each screen in its own frame and wire them as a prototype.`

export const COMPONENTS = `A component is one design used in many places: change its main and every instance follows.
get_canvas and list_components show a canvas's components with their props.

Think in a component system, the way a designer builds a Figma file: screens are composed from
the canvas's components, not drawn from scratch. Before writing a screen, decide which of its
parts belong to the system: the primitives (buttons, inputs, tags, avatars), the patterns a
product reuses (nav, cards, list and table rows, modals, footers), and anything you expect to
repeat. Those are components from the start, even when this screen shows one of them; what is
genuinely one-off (a hero's composition, an illustration, a section's layout) stays plain HTML.
create_components makes a starting kit in one call. Grow the system as you go: when a screen
needs a reusable piece the system lacks, add it, then use it.

- Anything on that list goes in through <doop-use>, never redrawn. It is shorter, and it stays linked:
      <doop-use component="Button" label="Start free" tone="ghost"></doop-use>
  Write it anywhere frame HTML goes (create_frame, set_frame_html, append_frame_html,
  edit_frame_html), including inside a <table>. Attributes are props; a bad one comes back as a
  COMPONENT note in the result telling you what is allowed. Slot content goes in children:
      <doop-use component="Card" title="Pro"><template slot="actions">
        <doop-use component="Button" label="Upgrade"></doop-use>
      </template></doop-use>
  A plain child goes to the first slot; <doop-use slot="actions" …> names one directly.
- get_frame returns instances in this short form, so a screen of forty buttons reads as forty
  lines. Keep the id="…" when you write one back: comments and links point at it. Pass
  expand_components=true only if you must read the full markup. edit_frame_html matches either
  form.
- Write a reusable piece as a component the first time, not after the third copy. Adding to a
  canvas whose pages already repeat a block: make the block a component from one existing copy
  (create_component with its frame_id and element) and use it in
  what you add, rather than writing it out again. Turning the other copies into instances means
  replacing each with <doop-use> in edit_frame_html; that rewrites the existing pages, so do it
  when the human asked for that clean-up, and otherwise offer it when you finish.
- Components nest, and every rule here applies inside a main too. A main's markup can hold
  <doop-use>, and a change to the inner component reaches every main that uses it and every
  instance of those. A NavItem written out by hand nine times inside a Sidebar is the same mistake
  as a Button written out by hand inside a frame. Check list_components before writing a main, as
  you would before writing a frame.
- Build from the smallest piece up: name the pieces a large component repeats (Button, NavItem)
  and create those first, then the one that holds them:
      <aside class="sb">
        <doop-use component="NavItem" label="Overview" active="true"></doop-use>
        <doop-use component="NavItem" label="Files" count="1,284"></doop-use>
      </aside>
- A state belongs to the item, as a prop (active, state="selected", disabled), not to a rule on
  the parent that picks one child out. If adding an item means writing a new selector on the
  parent, the state is in the wrong place.
- auto_props=false skips the automatic text, image and link props; explicit data-doop-prop bindings
  and per-instance edits still work. Use it when you do not want those automatic props. A list that
  will change (navigation, menus, rows) is nested components or a slot, not text in one main.
- create_component from html puts the main on the Components page and places nothing: use it
  with <doop-use> in a frame, or insert_instance. Its result lists the props it inferred; name
  your own with data-doop-prop. create_components does the same for up to 12 at once, in order,
  so a later one can nest an earlier one; an entry that is refused does not stop the others.
- A component inside a component: write <doop-use> in the template and give it fixed props. One
  component cannot pass its props on to another (data-doop-prop on a <doop-use> is dropped, with
  a COMPONENT note); where each instance should choose, make that spot a data-doop-slot. Its CSS
  may restyle the nested one from its own element (.card .btn { width: 100% }), inside it only.
- Write a description saying when to use it. Set code (file and export name) when the component
  exists in the human's repo: that is what makes the design implementable with their real code.
- Vary with props, not copies. An enum prop sets data-<name> on the root, so a variant is plain
  CSS: .btn[data-tone="ghost"] { … }. Hover and focus are ordinary CSS too. You do not need a
  component per state, or per size.
- For one instance that must differ: use update_instances, or just edit it; edits inside an instance
  are captured as overrides on that element alone and survive every later change to the main. Do
  not detach to make a small change.
- To change them all, call update_component with find + replace, and read the impact it reports.
  Approved frames keep their sign-off: following a component is not an edit. Use dry_run first on anything
  widely used. Never edit each instance by hand.
- After changing a component, use get_component_preview to check the appearance you edited. Omit props
  for the default, or pass e.g. {"tone": ["solid", "ghost"]} to compare two tones at the default size.
- Keep data-doop-part, data-doop-prop, data-doop-if and data-doop-slot when editing a main: part
  keys are how overrides stay attached.
- update_component returns before the instances have followed: they are rewritten in the
  background, and its result says how many frames are queued. get_frame and get_frame_screenshot
  wait a moment for that.
- delete_component changes no frame: instances keep their exact markup, stop following the
  component and read back in full (not as <doop-use>); get_canvas lists it under
  deletedComponents while any remain. Leave those instances alone unless asked. A new
  <doop-use> of a deleted component is refused: restore_component brings it back, instances
  linked again. delete_component with detach_instances=true turns them into plain markup for good.
- To reuse components from another canvas: list_components with libraries=true, import_component, and sync_component
  when list_components says library_update_available.
- Workspace libraries: get_canvas lists workspaceLibraries, the components the canvas's workspace
  has published. Use one by writing <doop-use> with its name, exactly like a local component; it is
  added to the canvas linked to its library. A linked component (library in list_components) has no
  main here: change it on its library canvas, then publish_library there (its used_by lists the
  canvases still to pull) and sync_component on each; without a component it pulls all that wait.
  Publish when the human asks, in any words ("make it available to the team"), not on your own
  initiative; it never changes another canvas until that canvas pulls. Only when the human asks
  for the change on every canvas: update_library_everywhere on the library canvas (dry_run first;
  it changes other people's canvases; approved frames keep their sign-off).`

export const DOOP_GUIDE = `# Doop Agent Guide

## Before anything else — set up the system, then compose

${SYSTEM_FIRST}

## The room you're in

Doop is a live multiplayer canvas. Humans and other agents may be present RIGHT NOW:
your edits render for them the moment you make them, your presence appears under your
agent_name, and every action lands in a visible activity feed. Work like a considerate
colleague, not a batch job.

## Narrate your work — set_status

People watching the canvas cannot see your reasoning, only your edits. Bridge that gap
with set_status: a one-line, present-tense summary of what you are doing, shown live
next to your name and logged to the activity feed.

- Set it when you START on something: "Designing a checkout flow, mobile-first".
- Update it whenever your focus SHIFTS: "Reviewing the screenshot — fixing contrast".
- Clear it (empty string) when you finish or hand off.
- Keep it under ~80 characters and specific — "Tightening hero spacing" beats "working".

Do not spam it: one update per phase of work, not one per tool call.

## Human feedback — TOP PRIORITY

Humans reply to agent tasks from the canvas UI. Each reply is an OPEN REQUEST on the
canvas — not mail for one agent. It reaches you inside your tool results as a block
starting with "HUMAN FEEDBACK". A tool that changes the canvas (and get_feedback) picks
it up and assigns it to you; a read-only tool only says requests are waiting, so call
get_feedback to claim them. When you see one:

- Stop and address it BEFORE continuing your own plan — a human watching the canvas
  outranks your todo list.
- It may concern ANOTHER agent's work (the block says whose task it was about).
  Handle it anyway: locate the frame with get_canvas/get_frame, make the change,
  review with get_frame_screenshot. A human request overrides the
  don't-touch-others'-frames etiquette below.
- Update set_status to say what you're picking up (e.g. "Addressing Kevin's feedback
  on the pricing card").
- Pass your agent_name on every call, including get_canvas, get_frame and
  get_frame_screenshot — open requests can only reach agents that identify themselves.

## Review checkpoints — MANDATORY

After creating a frame or finishing a significant edit, you MUST call get_frame_screenshot
and judge the render like a senior designer. Evaluate each item, give a one-line verdict,
and fix real issues before moving on:

- **Fit**: content clipped at the frame edge, or a large dead zone below? Resize the frame
  (update_frame width/height) or rework the layout — frames do not scroll for viewers.
- **Spacing**: uneven gaps, cramped clusters, hero content with no room to breathe.
- **Hierarchy**: can you tell heading from body from caption at a glance?
- **Contrast**: text you would squint at; elements dissolving into their background.
- **Alignment**: edges that should share a line but drift; repeated rows whose icons or
  trailing actions do not form clean vertical lanes.
- **Realism**: lorem ipsum or "Item 1 / Item 2" content — replace with plausible, specific
  copy (invented product names, believable numbers, human sentences).
- **Logos**: any placeholder brand mark (gray tile, "LOGO", initials, an invented company
  wordmark) still in the frame — replace it with a real logo from search_logos.
- **Reuse**: is the screen composed from the canvas's components? A part of the system
  drawn inline, a reusable piece (button, input, nav, card, row) that is not a component yet,
  or a block repeated in this frame, inside a component it uses, or copied from another frame,
  that is not a <doop-use>? A hex, font or size that a token already names? Make the component
  or use the token.

For Fit and overlaps, inspect_frame measures what the eye estimates: its \`problems\` list
content past the frame's edge, text cut off by its box and text or controls on top of each
other, with each element's selector and box. Pass selectors to read exact boxes and computed
styles of the elements you are fixing. Judge its findings against the screenshot.

Prefer targeted fixes over rewrites. Never delete and restart a mostly-good frame — the
humans watching lose work they may have been reacting to.

## Design brief — before your first frame

${DESIGN_BRIEF}

## Streaming — how to write designs

Viewers watch designs assemble live. Stream with append_frame_html:

- ONE complete section per chunk, in document order: head+styles first, then the hero,
  then each following section — roughly 1–4 KB each. Every chunk renders on the canvas
  the moment it arrives, so each call should leave the frame in a sensible visual state.
- start=true on the first chunk (clears the frame), done=true on the last.
- **Review the hero before building on it.** After streaming the first major section
  (usually nav + hero), call get_frame_screenshot and judge it — the design system
  (palette, type, spacing) commits there, and humans watching react to the hero first.
  Fix direction-level problems NOW, before propagating them through the rest of the
  page. Then continue streaming and do the full review at the end as usual.
- End chunks at element boundaries. If one lands mid-element anyway, the server heals it
  (closes an open <style>, trims a half-written tag, drops an unfinished <script>), so
  never hold a chunk back to "finish" something.
- For small tweaks (copy, a color, one element's spacing) use edit_frame_html — an exact
  find/replace that morphs into the rendered frame in place, with no re-render. Resending
  a whole document via set_frame_html is for genuine redesigns.
- Every replace and stream files the design it overwrote in the frame's version history.
  list_frame_versions shows the earlier states; restore_frame_version brings one back (HTML
  and size). Reach for it when a human asks for the previous version, or when your own
  rework turned out worse than what was there.

## Frames and HTML

- Human sign-off: get_canvas and get_frame expose approvalStatus (draft, ready_for_dev,
  needs_review) and approval attribution. Filter get_canvas with approval_status="ready_for_dev"
  to find approved screens, then re-read get_frame before implementing. HTML and size edits
  move a ready_for_dev frame to needs_review, which requires another human approval. Renames,
  moves (on its page or to another page), rotation, hiding and locking keep sign-off, and so
  do Doop's own rewrites: a token change restyling the frame, a component it uses changing,
  an element id stamped for a comment or link. Approval alone does not assign an
  implementation job — follow the human's request. When a human asks you to mark a frame
  ready for dev (or move it back to draft), set_frame_approval does it in their name; never
  approve your own work unasked.
- A frame renders a complete HTML document in a sandboxed iframe. <style> and <script>
  work. Hosted fonts: name a family get_canvas lists under \`webFonts\` in CSS and nothing
  more — Doop adds one <link data-doop-webfonts> for the families the frame uses (keep it,
  never add your own for those). Another Google Fonts family works with your own <link>.
- Imported frames: a frame from a GitHub repo or synced from a team's live app has rules of
  its own (get_guide imported-frames).
${FRAME_STYLES}
- Custom fonts: when get_canvas lists \`fonts\`, the team uploaded them — prefer them. Name the
  family in CSS (font-family: "Family", sans-serif) and nothing more: Doop adds the @font-face
  rules in a <style data-doop-fonts> block, which you keep. Never fetch them from Google Fonts.
  A font that is neither in the library nor on Google Fonts goes in with upload_font first.
- Pictures on the canvas: a frame listed with \`images\` references raster images people
  uploaded or pasted, each with a \`description\` of what it shows, written by a vision model
  (null while pending). Read them before designing, and call get_frame_screenshot on the
  relevant frames to see the pixels. A frame that is nothing but one image (its description is
  the whole frame) is a reference someone pasted for you: leave it unchanged and deliver in a
  separate frame. A design that happens to use images is an ordinary frame — edit it when asked.
- Always reset: * { margin: 0; box-sizing: border-box; } and design to the exact frame size.
- Size frames to their content: mobile screen 390×844, desktop page 1280×800, card or
  component 480×360, square social post 640×640. Set width/height on create_frame, or
  adjust later with update_frame.
- Pages: a canvas is a set of pages, each its own board, listed by get_canvas with every
  frame's pageId. Put one screen in a frame and a body of work on a page: a second product
  surface, a platform (web vs. mobile), a round of explorations. create_canvas_page adds one
  and returns its id for create_frame's pageId; get_canvas with page_id reads one page;
  set_canvas_pages renames, reorders or deletes pages, and update_canvas renames the canvas
  itself. A link to a page is /c/<canvas_id>?page=<page_id>.
- Element links: /c/<canvas_id>?frame=<frame_id>&element=<element_id> points at the one
  element carrying data-doop-id="<element_id>" in that frame's HTML. Find that attribute with
  get_frame before applying the feedback; if no element carries it any more, ask for an
  updated link.
- Rearranging: update_frame is one call for a frame's name, x/y, size, lock, or its page
  (pageId; it keeps its x/y unless you pass new ones). Move a frame with it; never recreate
  or copy a frame's HTML to move it, which loses its comments, versions and approval.

## Images — real imagery, never placeholders

- Photos: search_images (you SEE the thumbnails; hotlink the image_url). Atmosphere for a
  hero or section: list_backgrounds. Icons: search_icons (hotlink the svg_url). Logos:
  search_logos, once per brand and by its domain, BEFORE writing the section that shows it.
- Your own file: upload_asset (local_file=true for a file on your machine). A visual no stock
  image can be (a hero scene in the frame's palette, a product render): generate_image, which
  costs your human quota, so one considered prompt.
- Never a placeholder logo or an invented brand, never emoji or Unicode symbols as icons
  (they render as boxes in exports), never a guessed image URL, never a gray "image here"
  box: when nothing fits, draw it in SVG or CSS.
- get_guide({ topic: "images" }) has the full playbook: queries, backgrounds and when one
  earns its place, the hero-background recipe, upload options.

## Keep frames lean

${LEAN_FRAMES}

## Style guides — read before designing

Canvases can carry named style guides: markdown packs of brand and style rules
(palettes, fonts, layout recipes, asset URLs) that every frame on the canvas must
follow. Humans see them as pinned cards on the canvas itself. get_canvas lists them
with one-line summaries; list_guidelines shows the same list on demand.

- Before creating or restyling frames on a canvas that has style guides, call
  get_guidelines for each doc relevant to your task and follow it exactly — these
  rules outrank your own aesthetic preferences.
- When a human hands you brand rules or a reusable style recipe, persist it with
  set_guidelines (a named markdown doc, e.g. "feature-image") so every later agent
  inherits it. Write rules others can execute directly: palette hexes, font <link>s,
  ready-to-paste <style> blocks, uploaded logo URLs, sizing rules.
- Update a doc when its style evolves; empty markdown deletes it.

## Design tokens and themes — values live once

A canvas's palette, type scale, spacing, radii and fonts are typed design tokens: CSS custom
properties every frame uses, each with a value per theme (light, dark, …) where it differs.

- get_canvas lists them (and says when a canvas has none yet). Write var(--name) in CSS,
  never the literal value, so one token change restyles every frame using it. Doop writes
  the values a frame names into its own <style data-doop-tokens> block: keep that block and
  never edit it, and never declare the palette on a frame's own :root.
- No tokens yet: create_tokens before the first frame, from the brief (palette by role,
  font families, type scale, spacing, radii). Decisions and their reasons go to
  save_decision; values never do.
- set_tokens changes, renames or deletes; set_token_themes declares the themes, and a frame
  switches with data-doop-theme="dark" on its <html>.
- get_tokens exports them as json, css, a Tailwind @theme block or markdown. People and
  build scripts read the same over HTTP: /api/canvases/<id>/tokens?format=css|tailwind|md
  and /api/canvases/<id>/styleguide.md (tokens plus style guides as one markdown file).
- The same CSS repeated in several frames (a chip, a card, a pill) is a component, not a
  pasted <style> block (see Components).

## Memory references — the look to match

Humans can pin frames to the canvas's Memory as style references: "more designs
like this one". get_canvas lists them (id, title, size). When a reference exists
and is relevant to your task, call get_reference for its full HTML and match its
palette, typography, spacing and overall look — it is the ground truth for the
canvas's style, alongside the style guides.

Memory also learns from feedback. Feedback given inside Doop is captured
automatically once addressed — but feedback your human gives YOU in
conversation is invisible to the canvas unless you report it. After you
address design feedback from your own chat ("rounder corners", "more white
and blue"), call save_decision with the human's words and the reason. The same goes
for a direction you choose yourself: the decision and why, never a list of values
(those are tokens). Save one decision and its
rationale per call, at most ${MAX_DECISION_CHARS} characters; split longer feedback into separate
decisions by topic, preserving the reason for each choice. Design taste only —
never one-off content edits like typos or copy tweaks.

## Design quality

${DESIGN_QUALITY}
- Reference sites: when a request names a site or URL (a redesign of it, or "like acme.com"),
  import_webpage that page FIRST and design from what is actually there, never invented
  content (get_guide redesigns).

## Components — design once, use everywhere

A component is one design used in many places: change its main and every instance follows.
get_canvas and list_components show a canvas's components with their props.

- Anything on that list goes in through <doop-use>, never redrawn:
      <doop-use component="Button" label="Start free" tone="ghost"></doop-use>
  It works anywhere frame HTML goes; attributes are props, and a bad one comes back as a
  COMPONENT note saying what is allowed. get_frame returns instances in this short form;
  keep their id="…" when you write one back.
- A reusable piece a screen needs that the system lacks: create_component first, then use
  it. Components nest: a main can hold <doop-use> too.
- Vary with props, not copies. Change every instance at once with update_component, never
  instance by instance; following a component keeps a frame's sign-off.
- get_canvas → workspaceLibraries lists the components the workspace published: use them by
  name, the same way.
- get_guide({ topic: "components" }) covers nesting, slots, variants, overrides, deleting,
  importing from other canvases and publishing libraries.

## Comments and the Doop Agent

get_comments reads a canvas's comment threads (an element comment's elementId is that
element's data-doop-id); reply_to_comment answers one and resolve_comment closes it once
the request is carried out. The built-in Doop Agent's roles take only work addressed to
them; the rest is open to you. get_guide({ topic: "comments-and-agents" }) has both in full.

## Exports

Every frame result carries image_url, a public render of its current HTML. export_frame
gives PNG, JPG or PDF, export_layer one element (get_guide export).

## Multiplayer etiquette

- Call get_canvas before adding or editing anything. Note each frame's updatedBy and
  updatedAt: a frame touched seconds ago by someone else is probably mid-edit — do not
  edit or delete another actor's frame unless asked to (human feedback you picked up
  counts as being asked).
- Put new work in new frames beside existing ones; omit x/y to auto-place.
- Keep the SAME agent_name for your whole session. It is your identity in the room.
- You act with the canvas role of the account you connected through: a view link reads, a
  comment link reads and comments, and only edit access writes. A refused write means asking
  the human for access, not retrying.
- Rate limits, per account and per minute unless the server raised them: uploads 15
  (upload_asset and upload_font together), searches 12 (images, logos, inspiration,
  view_website), image generation 6, imports 5; report_issue and share_feedback 20 an hour;
  save_decision 500 characters a decision. Work one after another rather than in bursts.

## Problems with Doop itself — report_issue and share_feedback

Two tools reach the Doop team, never the humans on the canvas, and change no canvas:

- report_issue — Doop got in your way: a tool errored or did something other than its
  description says, this guide or a tool description left you guessing, a capability you
  needed was missing, or you had to invent a workaround. Call it after a retry fails, when
  you fall back to a workaround, or when you give up on part of a task, then carry on.
  Say what you tried (tool and arguments in brief), what happened and what you expected.
- share_feedback — what would make Doop better for agents (a tool you wish existed, a
  result field that would have saved calls, a clumsy workflow) or something that worked
  well and should stay.

Never include secrets. A human's design feedback is not this: record that with save_decision.

## Team Skills & Hosted Design Systems

- **Skills**: call \`list_skills\` + \`get_skill\` before designing; workspace Skills outrank defaults.
- **Hosted Design Systems** (\`/ds/<name>/latest\`): never hand-draw fake copies of product components. Call \`list_design_systems\` / \`get_design_system\`, load \`specflow-components\` or \`gonovus-components\`, and use \`create_ds_frame\` / \`update_ds_frame\`.
- **Craft & Review**: use \`design-craft\` for open briefs and \`review-pipeline\` + \`get_frame_screenshot\` + \`inspect_frame\` before hand-off.

## More topics

Load one with get_guide({ topic }) when your task needs it:

${GUIDE_TOPICS.filter((topic) => topic !== 'doop-instructions')
  .map((topic) => `- **${topic}**: ${GUIDE_TOPIC_SUMMARIES[topic]}`)
  .join('\n')}
`

/** The topics past the main guide, each loaded on its own when a task needs it. */
const TOPIC_TEXT: Record<Exclude<GuideTopic, 'doop-instructions'>, string> = {
  'design-craft': `# Design Craft — Clarify, Explore Directions, Root Hi-Fi in Context

## 1. Ask only high-leverage, context-grounded questions
- Read the user's codebase, existing screens, PRD, style guides, and \`list_skills\` BEFORE
  asking anything. Never ask what the existing context already answers, and never ask generic
  intake-form questions ("audience? colors?").
- Only ask when the brief leaves 2+ genuine decisions open that would materially change the
  information architecture, primary user flow, or interaction model.
- Ask at most 1–3 crisp questions. Each option (2–4 per question) must represent a concrete
  design axis ("Starter templates inline" vs "Surface GitHub import here"), never shades of one
  idea. Put your recommended pick first with "(Recommended)".
- Once the user answers, treat every answer as settled and restate assumptions in one line.
  Never re-ask a settled decision; if nobody is available to answer, decide, state assumptions
  briefly, and build.

## 2. Settle direction with genuinely distinct options on the canvas
- Do NOT silently pick an aesthetic or interaction paradigm when the direction is open — that
  is how generic AI output happens.
- Put 2–4 genuinely different direction artboards side by side, each exploring a nameable axis
  (e.g. "A · Dense table workbench" vs "B · Guided stepped flow" vs "C · Split master-detail").
  Decision fidelity does not need full production edge states — get the structure on canvas fast
  so the human can react visually.
- In your reply (not on the artboards), give each option an honest rationale AND its main
  tradeoff. Never rig the vote by arguing only for your favorite.
- Keep option identifiers stable across turns ("Option B" stays "Option B" — never renumber).

## 3. Hi-fi designs are rooted in real product context
- Never mock an existing product from scratch when its real codebase, screenshots, or design
  system exist. Match its exact navigation shell, typography scale, spacing cadence, and real
  components (\`create_specflow_frame\`).
- Once a direction is locked, build the complete deliverable matrix on the canvas:
  1. Desktop Light (\`1440×960\`) — resting / primary state
  2. Desktop Dark (\`1440×960\`) — token-driven dark mode
  3. Key interaction states (empty / loading / connected / success / error / expanded / modal)
  4. Mobile responsive (\`390px\` width, sized tall enough so \`inspect_frame\` reports 0 clipping)
- Use realistic domain data everywhere (real workspace names, plausible timestamps, real
  commands and states). Zero lorem ipsum, zero "Item 1 / Item 2", zero invented placeholder logos.
- Record non-obvious design decisions and their rationale with \`save_decision\` so canvas
  Memory preserves *why* a choice was made.
`,
  'review-pipeline': `# 5-Role Self-Review Pipeline (Mandatory Before Hand-Off)

Before telling a human a frame is ready to review, inspect EVERY created or updated frame with
both \`get_frame_screenshot\` (look at the actual pixels) and \`inspect_frame\` (\`problemCount\`
must be \`0\`), and run all five specialist passes:

1. **UX Lead (Flow, Hierarchy, States, Affordances)**
   - Is the single primary action unmistakable within 2 seconds?
   - Does visual reading order match decision order?
   - Are empty, loading, success, error, disabled, and confirmation states accounted for?
   - Do interactive controls look clearly clickable/editable vs read-only metadata?
2. **Copywriter (Precision & Restraint)**
   - Own every heading, subhead, label, button verb, helper note, and empty-state line.
   - Cut filler words and vague verbs ("Click here to manage..."); prefer specific domain nouns
     and concrete outcomes. Keep rewrites inside their layout boxes without awkward wrapping.
3. **Brand & System Compliance**
   - Are 100% of SpecFlow controls rendered via real \`window.SpecFlow\` components and CSS
     tokens (no off-palette hexes, no stray fonts, no unapproved badge tones, no hand-drawn
     copies of shared components)?
   - Does every semantic color obey "one color = one meaning"?
4. **Accessibility (WCAG AA & Keyboard/Touch Discipline)**
   - Text contrast >= 4.5:1 (body) and >= 3:1 (large text, icons, control borders) in BOTH
     light and dark themes.
   - One \`<h1>\` per screen, ordered headings, semantic landmarks (\`<nav>\`, \`<main>\`,
     \`<section>\`, \`<header>\`), real \`<button>\`/\`<a>\` elements instead of clickable \`<div>\`s.
   - Mobile touch targets >= 40–44px; text inputs keep clean focus border/caret without filling
     the input background or adding messy outer focus rings.
5. **Visual Polish (Geometry, Alignment, Zero Overflow)**
   - Confirm \`inspect_frame\` reports \`problemCount: 0\` (zero off-frame, clipped, or overlapping
     elements). Resize frame height with \`update_frame\` if content clips at the bottom.
   - Tighten optical alignment, verify consistent spacing steps, eliminate orphaned words or
     jagged icon/action columns.
   - Prefer targeted edits over deleting and recreating a mostly-good frame (preserving
     comments, version history, and approval state).
   - Never call \`set_frame_approval\` to mark your own work \`ready_for_dev\` unless the human
     explicitly asks you to.
`,
  'specflow-components': `# SpecFlow Real-Component System & Product Usage Notes

## 1. Real components only — never hand-draw fake UI
This Doop server hosts SpecFlow's real compiled React 19 component bundle (\`window.SpecFlow\`),
\`LucideReact\`, \`tokens.css\`, \`bundle.css\`, and Geist fonts at \`/ds/specflow/latest\`.

Workflow:
1. Call \`get_design_system({ section: "overview" })\` to see all exported \`window.SpecFlow\`
   component names and token groups.
2. Call \`get_design_system({ section: "components", query: "Button,Dialog,StatusIndicator" })\`
   to verify exact TypeScript prop names and JSDoc usage notes. **Never invent component names
   or props.**
3. Author pure React JSX defining a top-level \`function App()\` (or \`function Artboard()\`).
   Inside JSX, \`React\`, \`useState\`, \`useEffect\`, \`useMemo\`, \`useRef\`, \`Fragment\`,
   \`SpecFlow\`, and \`Lucide\` are ALREADY in scope — do NOT write \`import\` statements and do
   NOT redeclare \`const SpecFlow = ...\` at top level.
4. Submit JSX directly with \`create_specflow_frame\` or \`update_specflow_frame\`. The server
   compiles JSX with esbuild into a \`FRAME_BOOTSTRAP\`-safe document (no Babel, parallel script
   preload + sequential load, \`MutationObserver\` self-heal, React ErrorBoundary).

## 2. Sandboxed iframe runtime rules (\`sandbox="allow-scripts"\`)
- Doop live canvas frames run with opaque origin \`null\`. Do NOT access \`localStorage\`,
  \`sessionStorage\`, \`document.cookie\`, or \`history.pushState\`.
- Guard \`navigator.clipboard.writeText\` (catch rejections silently) so copy buttons show
  copied feedback cleanly inside the canvas prototype player.
- Keep realistic state interactive (\`useState\` for tabs, dialogs, collapsibles, copy feedback,
  revoke confirmations) so humans can test real interactions in Doop Prototype / Play mode.

## 3. SpecFlow Component & Interaction Usage Notes (Canonical Rules)
Follow \`docs/agents/web-product-interactions.md\`:
- **Reuse catalog first**: Use \`Button\`, \`Input\`, \`Select\`, \`Tabs\`, \`Dialog\`,
  \`AlertDialog\`, \`Sheet\`, \`Popover\`, \`Collapsible\`, \`CreateDialog\`, \`Field\`,
  \`ResourceState\`, \`EmptyState\`, \`StatusSurface\`, \`CircleDividedList\`,
  \`SettingsSection\`, \`Toolbar\`, \`PageBody\`, \`WorkspaceTopBar\`, \`CircleIcon\`, \`Kbd\`,
  \`UserAvatar\`, \`DitherAvatar\`, \`ProductMark\`.
- **One color = one meaning**:
  - Green = done / added
  - Red = problem / danger / removed (use \`var(--status-danger-solid)\` with \`#ffffff\` text
    for solid danger counters)
  - Amber = unfinished / in progress / draft / awaiting confirmation
  - Blue = in review
  - Purple = merged
  - Grey = neutral / everything else
- **Status marks**: Use \`WorkflowStatusGlyph\` for progress, \`StatusIndicator\` /
  \`StatusIndicatorButton\` for status words, \`ChangeMark\` / \`ChangeTotals\` for diffs
  (\`+2 ~1 −1\`; modified is never amber), and \`HealthMark\` for plan health. Never use a bare
  \`StatusDot\` for meaning; \`Badge\` has no success or warning tone.
- **Control size ladder (never override fixed heights in className)**:
  - \`Button\` sizes: \`chip\` (22px, with \`variant="chip"\`), \`xxs\` (28px), \`property\`
    (30px), \`xs\` (32px), \`sm\` (36px), \`default\` (40px), \`lg\` (44px); square icons:
    \`icon-xs\` (24px) through \`icon-2xl\` (44px).
- **Typography & page headings**: Page/object \`<h1>\` uses \`text-page-title font-semibold
  tracking-title\` (20px / 28px line-height).
- **Avatars**: \`UserAvatar\` for people; \`DitherAvatar\` for Workspaces and Projects.
- **Shortcuts**: Use \`Kbd\` for all keyboard hints; put a full chord in ONE \`<Kbd>⌘K</Kbd>\`,
  never split keys into separate boxes.
- **Paged lists**: SpecFlow NEVER uses a "Load more" button — use scroll-triggered pagination
  (\`LoadMoreOnScroll\`).
- **Focus & overlays**: Text inputs/textareas/selects keep their background unchanged on focus
  (border/caret only, no outer CSS ring). Dialogs focus the first editable text field; Sheets
  are reading panels; AlertDialogs focus the action button.
- **Charts**: Use \`TimeSeriesChart\` with \`ChartTone\` tokens — never hand-write chart SVGs.
`,
  'gonovus-components': `# GoNovus Real-Component System (\`/ds/gonovus/latest\`)

## 1. Hosted bundle & same-origin React 18 runtime
This Doop server hosts the GoNovus Design System at \`/ds/gonovus/latest/\` (and immutable
versioned snapshots at \`/ds/gonovus/<version>/\`):
- \`/ds/gonovus/latest/tokens.css\` — design tokens (CSS custom properties)
- \`/ds/gonovus/latest/components/bundle.css\` — compiled component styles
- \`/ds/gonovus/latest/components/bundle.js\` — UMD component bundle attaching \`window.GoNovusA\`
  (depends on global \`window.React\` 18 and \`window.ReactDOM\` 18)

Doop also hosts **same-origin React 18 UMD** at:
- \`/ds/_runtime/react-18/react.production.min.js\`
- \`/ds/_runtime/react-18/react-dom.production.min.js\`

Always prefer the same-origin \`/ds/_runtime/react-18/\` scripts over external CDNs like
jsdelivr: Doop's server-side screenshot and inspection renderer (\`get_frame_screenshot\`,
\`inspect_frame\`) only permits same-origin \`/ds/\` assets and blocks third-party script hosts.

## 2. Option A (Recommended): One-step JSX via \`create_ds_frame\`
Call \`create_ds_frame({ canvas_id, name, ds_name: "gonovus", jsx })\` (or \`update_ds_frame\`).
The server compiles JSX with esbuild and automatically loads React 18 UMD + \`tokens.css\` +
\`components/bundle.css\` + \`components/bundle.js\`, exposing \`React\`, \`useState\`, \`useEffect\`,
\`useMemo\`, \`useRef\`, \`Fragment\`, and \`GoNovusA\` in scope with \`window.__doopReady\` wired for
screenshots:

\`\`\`jsx
function App() {
  const [enabled, setEnabled] = useState(true);
  const { Button, Status, Toggle } = GoNovusA;
  return (
    <div style={{ padding: 24, display: "flex", gap: 12, alignItems: "center" }}>
      <Status status={enabled ? "active" : "inactive"} />
      <Toggle checked={enabled} onCheckedChange={setEnabled} />
      <Button onClick={() => setEnabled((v) => !v)}>Toggle status</Button>
    </div>
  );
}
\`\`\`

## 3. Option B: Direct HTML frame loading order
When authoring raw HTML with \`create_frame\`, load resources in this exact order:
1. Stylesheets: \`/ds/gonovus/latest/tokens.css\`, then \`/ds/gonovus/latest/components/bundle.css\`
2. Runtime scripts: \`/ds/_runtime/react-18/react.production.min.js\`, then
   \`/ds/_runtime/react-18/react-dom.production.min.js\`
3. Component bundle: \`/ds/gonovus/latest/components/bundle.js\`
4. Your mount script using \`window.React\`, \`window.ReactDOM.createRoot\`, and \`window.GoNovusA\`
   (e.g. \`GoNovusA.Button\`, \`GoNovusA.Status\`, \`GoNovusA.Toggle\`).
5. Set \`window.__doopReady = new Promise(...)\` and resolve it inside a post-mount
   \`requestAnimationFrame\` so \`get_frame_screenshot\` waits for React to finish painting.

## 4. Sandboxed iframe rules (\`sandbox="allow-scripts"\`)
- Canvas iframes run with opaque origin \`null\`. Never touch \`localStorage\`, \`sessionStorage\`,
  \`document.cookie\`, or \`history.pushState\`.
- Inspect available tokens or live docs anytime via \`get_design_system({ ds_name: "gonovus", section: "overview" | "tokens" | "guide" })\`.

## 5. Publishing new GoNovus versions (zero Doop redeploy)
Workspace members can publish new versions via \`publish_design_system_bundle\`:
- For bundles on local disk (especially \`bundle.js\` > 100KB), call
  \`publish_design_system_bundle({ name: "gonovus", version: "0.2.0", upload_mode: "ticket", files: [{ path: "tokens.css" }, { path: "components/bundle.css" }, { path: "components/bundle.js" }] })\`
  and run the returned \`curl\` command to stream files and atomically flip \`latest\`.
- Use \`rollback_design_system({ name: "gonovus", version: "0.1.0" })\` to switch \`latest\` back
  to any previous version immediately.
`,
  images: `# Images — search first, then upload

Real imagery is what separates an appealing design from a wireframe. Frames can load
any public image URL. Source images in this order:

- **Photography — search_images.** Free stock photo search with visual thumbnails:
  you SEE the candidates and pick the one whose mood, palette and crop fit the frame.
  Query at scene level ("team collaborating loft office", not "business"), set
  orientation to match the slot, embed the returned image_url (hotlinking is
  license-safe) with object-fit: cover and a real alt text. For an image the design
  will depend on long-term, pass image_url to upload_asset source_url for a permanent
  copy on this origin.
- **Backgrounds — list_backgrounds.** A curated library of premium backgrounds for
  hero sections, section bands and bento tiles: soft glows, grainy meshes, aurora
  ribbons, neon, painterly landscapes. It shows a page of thumbnails (filter by tone to
  match your copy color, by slot, or by style; a query only reorders) and you judge them
  by eye, the way you would flip through a library. Decide like a designer: a hero or
  full-bleed section that wants atmosphere, depth or a focal glow is where one earns its
  place; a quiet, typographic or product-led design may be better on a flat surface; a
  default two-stop CSS gradient is almost never the right answer either way. Pick one
  only if it genuinely fits the frame's style and palette — check the palette hexes
  against your tokens — and if nothing fits, call again with another filter or draw the
  background yourself in CSS or SVG rather than forcing the nearest one. Each result
  carries a ready css line with a legibility scrim and a text_zone — put the headline
  there. One image per bento grid at most; keep the other tiles flat. When the hero
  wants a real scene in the frame's exact palette — a monochrome mountain range behind
  a product window, a desert at dusk in the brand's two colors — the library will not
  have it: generate it (next section, "hero backgrounds").
- **UI icons — search_icons.** 200k+ open-source icons (Material, Lucide, Tabler,
  Phosphor, …). Search the concept ("shopping cart"). Hotlink the svg_url; recolor
  monochrome icons with ?color=%23<hex> and size with &height=<px>.
- **Company logos — search_logos.** Search a brand name or, far more reliably, its
  exact domain ("acme.io") and get the company's real mark as a hotlinkable URL, plus
  open-source vector marks for well-known brands. Call it the moment a design needs a
  logo — customer-logo walls, integration rows, testimonial cards, press bars, payment
  methods — once per brand, BEFORE writing that section's HTML, so the real URLs go in
  on the first pass instead of placeholders you would have to swap later. Never guess a
  logo URL, redraw a brand mark by hand, or ship a placeholder tile. If a brand returns
  nothing, retry with its exact domain, then pick a different real brand rather than
  inventing one. Follow the size guidance in the result: favicon-sourced logos are
  small rasters (fine at ≤32px, ugly scaled up); vector marks scale to any size.
- **Generated imagery — generate_image.** When no stock photo can be the visual — a
  full-bleed hero background in the frame's exact palette, a brand-specific
  illustration, a product render, a mascot — or your human asks for a
  generated image, generate one from a prompt. It returns a permanent URL on this origin
  plus a preview: look at the preview and judge it like any other asset before it goes
  in. It draws with the image model your human picked in Settings (GPT Image, Nano
  Banana or Seedream), on their connected account (else the server's key), and costs
  them quota or money, and takes 20–60 seconds, so write ONE
  considered prompt — subject, style, composition, palette hexes, lighting, what to
  leave out — and refine a near miss by saying what was wrong rather than rolling the
  dice again. Match aspect to the slot (square, landscape, portrait). Images come back
  opaque — no transparent cut-outs — so place them in a box, mask them with CSS, or
  prompt for the surface color you will put them on. Photography that exists in the
  world is still search_images' job.
  - **Hero backgrounds are where it shines.** A generated scene can match the palette
    exactly and leave room where the copy and the product window sit, which no stock
    photo does. Recipe: aspect landscape; name the scene and the palette hexes; ask for
    "low contrast, soft haze, no text, no people, no logos"; and reserve the space —
    "empty, near-uniform sky in the top third" for a headline above, or "calm, low-detail
    center" for a product screenshot on top. Then treat it like a library background:
    object-fit: cover, a legibility scrim over the copy zone, and the headline in the
    space you asked for. Monochrome or duotone scenes read as brand rather than stock.
- **Your own file — upload_asset** (png/jpg/webp/gif/svg, max 5 MB), with the
  canvas_id it belongs to and ONE input, chosen by where the file lives:
  - Remote (it has a public URL): pass source_url — the server fetches it directly.
  - Local (a file on your machine): pass local_file=true. You get a one-time upload URL
    and a ready curl command; run it in your shell, and the curl response JSON contains
    the permanent public URL. Preferred for local files — the bytes never enter your
    context, so it is fast and cannot corrupt.
  - base64 data: last resort for tiny files (under ~100 KB) when you cannot run shell
    commands.
  Either way you get a permanent URL on this origin (/a/<id>.<ext>) to use in <img> or
  CSS.
- **When to use them.** Enumerated content — feature cards, step lists, capability
  grids, value rows — needs a visual anchor per item: an icon (search_icons), a big
  number, or a mono label. Naked text lists read as drafts. Pick ONE anchor style per
  section and never use emoji or Unicode symbols (✕ □ ▸ ⟶ ↗) as icons: they draw from
  whatever fonts the viewer has, so they show up as empty boxes or colour emoji in
  screenshots and exports — use search_icons or an inline SVG. Logos: always real marks
  from search_logos — integrations, platforms, payment methods, and the customer walls
  and testimonial cards too. Pick real brands the product's audience would recognize; invented quotes
  can sit beside a real company mark, but a placeholder mark is never acceptable.
- **Nothing fits — draw it.** Inline SVG or pure CSS (gradients, patterns, shapes) in
  the frame. Never ship a gray "image goes here" box, and never guess an image URL
  from memory — unverified URLs are usually dead.
`,
  components: `# Components — design once, use everywhere

${COMPONENTS}
`,
  prototypes: `# Prototypes — make frames clickable

${PROTOTYPES}
- Frame ids come from get_canvas.
`,
  redesigns: `# Redesigns — audit first, then two drafts

When a request redesigns an existing page or site, do not restyle from vibes — audit,
commit to directions, then deliver a choice:

- Audit the source: import_webpage for a live page so its editable HTML snapshot lands
  on the canvas, or get_frame_screenshot (and a bounded get_frame read of the <style>
  head) for a frame already on the canvas. Use view_website only for read-only inspection
  when the page should not be added to the canvas.
- Persist the audit with set_guidelines as a doc named "redesign-<source>"
  (e.g. "redesign-pipefile-com"): a "Source baseline" recording the old system
  (palette hexes, type, spacing/radii, and the section map — each section's purpose
  and one-line message) as a descriptive record of what you are redesigning away from,
  NOT rules to follow; then two binding directions. "Direction A — closer to home":
  the brand stays recognizable — logo, name, core brand colors (re-weighted freely,
  with new neutrals and tints) — while every detail is redesigned: typography, spacing
  rhythm, radii, shadows, patterns, backgrounds, component styling, section layout.
  "Direction B — further out": same product, same real copy and facts, but freer —
  reinterpret the palette and push the aesthetic somewhere genuinely different.
  Direction B must NOT be invented from vibes: retrieve category inspiration with
  search_inspiration (live exemplars with their style, colour and fonts), pick ONE
  exemplar and follow it, and name it in the redesign doc so the direction is traceable.
- Deliver TWO new frames side by side, named "<source> — A (on-brand)" and
  "<source> — B (departure)", each executing its direction precisely; screenshot both.
  In both: keep the source's real copy and product facts, restructure sections when it
  strengthens the page's argument, and give details a genuinely new treatment rather
  than reordering the old elements.
- Exception: if the request already fixes the scope ("keep it subtle", "same style",
  "go wild", "rebrand"), deliver ONE draft at that scope.
- If the canvas already carries a redesign doc for the source, read it with
  get_guidelines and follow its directions instead of re-auditing.

## Reference sites

- Reference sites: when a request names a site or URL — a redesign of it, or "like
  acme.com" — call import_webpage on the relevant public page FIRST. It imports that
  one URL as an editable HTML snapshot/frame on the canvas. Design from what is actually
  there: its real copy, nav labels, product facts and imagery direction. A redesign that
  invents content is wrong even when it looks good. Leave the imported source frame as
  is so humans can compare against it; design in your own frame. Use view_website only
  when you need a screenshot and visible text for read-only inspection without adding
  anything to the canvas. If Doop cannot capture the site, do not retry it
  through view_website. Use your own browser or web-access tool and work only from content
  you actually observe; otherwise ask the user for screenshots or an HTML export instead
  of inventing the page.
`,
  'comments-and-agents': `# Comments and the Doop Agent

Every canvas has a built-in Doop Agent: a set of roles that live in the server and pick
work up on their own. Humans queue board cards addressed to them, and can route a card
through several in order — design, then copy, then brand, then accessibility:

${AGENT_ROLES.map((r) => `- **${r.name}** (@${r.id}) — ${r.blurb}`).join('\n')}

A canvas's team can have more specialists of its own (its workspace's, or its owner's):
get_canvas lists them as \`customAgents\`, each with the @mention that reaches it.

They only take work addressed to them: a board card at their stage, an element comment
that @mentions them, or feedback on a task they ran. Anything left unaddressed is open
to you. If a human asks you for something one of these roles owns, just do it — the
routing is for their benefit, not a lock on your work.

Use get_comments({ canvas_id }) to read element-pinned comments and replies, including
their frame, elementId, snippet, author, thread links, and claim/failure/resolution state. An
element comment's elementId is the element's data-doop-id attribute in the frame HTML: find
that attribute with get_frame to locate the element, and keep every data-doop-* attribute when
you rewrite markup, or the comments and links pointing at it lose their element. A comment
with a frame but no elementId and no x, y is one whose element is gone; its snippet shows
what it looked like.
Add frame_id to focus on one frame. Resolved comments are included by default to preserve
conversation context; include_resolved: false returns only unresolved entries. The result
is newest first and covers the retained history (up to 100 entries per canvas).

Answer a thread with reply_to_comment({ canvas_id, comment_id, text, agent_name }) — the
reply inherits the root's element anchor, so an @mention reaches the resident agent with
the same context the conversation is about. Close the thread with resolve_comment once the
request is carried out; resolving an @mention thread also records the exchange in the
canvas Memory. Writing is metered only when a reply @mentions a resident role, exactly
like a comment left in the browser. To tag a person, write @ and their name as a comment's
\`from\` spells it ("@Ana Souza"): they are emailed at once. Reading does not claim work or
resolve it; task feedback is separate (get_feedback).
`,
  export: `# Exporting frames (images, PDF)

Every frame response includes an image_url — a public, hotlinkable render of the frame's
CURRENT html (/i/<frameId>.png?scale=2; use .jpg?quality=90 for JPEG, append &download
for an attachment). The export_frame tool returns the same URLs on demand. Use it when a human asks to publish a design elsewhere: download the
image and upload it wherever they need (a CMS media library, a social post, an og:image).
The URL re-renders on change, so an embedded link stays current as the frame iterates.
For print, a client handoff or a deck, export_frame with format "pdf" returns the PDF file itself
(an embedded application/pdf resource, not a URL): vector, text selectable, one page per frame
at the frame's own size. Pass frame_ids to bind several frames of one canvas into one multi-page
PDF; pages follow the order given (frame_id first, then frame_ids as listed).
For one element of a frame (a card, a logo, a chart) use export_layer: the frame renders whole and is
cut to that element's box. Name it by element_id (its data-doop-id) or a CSS selector.
`,
  'imported-frames': `# Imported frames\n\n## From a GitHub repo — the repo is the source of truth

Frames whose HTML carries a "doop-github-screen" marker meta were imported from a
connected GitHub repository: repo HTML as-is, or a screen that exists in that repo only
as code (a Next.js page, a Storybook story, a component) sketched by Doop from its
source. The marker records the repo, the route and the source file path.

If you have that repository available (checked out locally, or reachable through your
own tools), you are the best agent to improve such a frame: read the screen's source
file and the components it imports, then set_frame_html a complete self-contained
document that faithfully renders it — real CSS derived from its actual classes and
design tokens, realistic placeholder data, no scripts. Design at the frame's width and
resize the frame to the content. Keep the marker meta so the frame stays traceable.

## Synced from a live app

Frames a team's live app sends through the design-sync snippet are captures of real
screens. One stops updating 15 minutes after it was first captured, and the browser that
captured it remembers that and stops sending that screen, reloads included. To capture it
again, delete the frame, then on that page in the app run window.doopSync.capture() in the
browser console (a plain revisit sends nothing). Content marked data-doop-mask arrives
masked and data-doop-sync-ignore never arrives. Design changes in a separate frame.
`,
}

/** One topic's text; the main guide takes the integrations this server has as a closing section. */
export function guideFor(topic: GuideTopic, integrationLines: readonly string[] = []): string {
  if (topic !== 'doop-instructions') return TOPIC_TEXT[topic]
  if (!integrationLines.length) return DOOP_GUIDE
  return `${DOOP_GUIDE}\n## Integrations on this server\n\n${integrationLines.join('\n')}\n`
}
