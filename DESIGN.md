# Design

<!-- impeccable:design-schema 1 -->

## World

Breath meridian: a sage-ash bench with one deep-teal breath orb as the
single live signal. Transcript is a river; setup is a rail. Light desk
scene, restrained strategy — neutrals tinted from sage plus one committed
accent. State is line form first (solid live, dashed connecting, double
error), hue second, so status never depends on color alone.
No marketing chrome.

## Tokens

- Ground `--ground: #e0e5e0` · surface `#fbfcfb` · surface-2 `#edf1ec`
- Ink `#1e1d19` · muted `#5f665f` · line `#cfd6cf`
- Accent teal `#0e6e62` (hover `#0a544b`, tint `#d8ece6`, ink `#0a3f38`)
- State pairs: green `#166534/#dcfce7`, amber `#92400e/#fef3c7`, red `#b91c1c/#fee2e2`
- Radius 14px cards, 10–12px controls · shadow `0 1px 2px + 0 10px 28px`
  (offset + blur, never flat halo)
- Type: system stack; h1 20 / h2 16 / body 15 / meta 12–13; tabular numerals
  for timer + timestamps; transcript bubbles max 70ch.

## Composition

Sticky top bar (brand + model badge + status pill + timer) over a two-column
grid: 384px setup rail (one card in task order: interview focus → call →
AI brief as disclosure) beside a
sticky transcript column (feed head, scrolling feed, interim partials, hint
footer). Stacks to one column under 960px. While live, the focus and brief
steps hide so Stop / Wrap up and the transcript dominate.

## Signature

The breath orb (concentric rings, transform + opacity only, 3.6s listening /
1.15s speaking) arriving while the mic meter moves via `transform: scaleX`
and the rail under the topbar fills — the whole "it is listening and
speaking" state readable in one glance.

## States

Idle / Connecting / Live (pulsing) / Error pills with text labels, never
color-only. Mic meter via `transform: scaleX` (compositor-only). AI-speaking
dot. Empty feed state, dashed system notices, interim "You…/AI…" partials.
Focus-visible rings, themed selection + caret + scrollbar.

## Provenance

No generated rasters; icon is inline SVG drawn for this surface. Detector clean
(`detect --json` → `[]`).
