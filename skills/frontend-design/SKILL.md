---
name: frontend-design
description: "Design taste and hard rules for building app UIs that look hand-crafted, not AI-generated. Use whenever building or styling any web or app frontend - pages, components, layouts, marketing sites, dashboards, emails. Enforces no em-dashes, no emojis, no gradients, consistent left alignment, real type and color systems, and real content. NOT for backend/API logic or build orchestration."
---

# Frontend Design

Build interfaces a senior product designer would be proud to ship, for THIS product specifically. The failure mode to avoid is the "AI-built app" look: generic, templated, the same every time, decorated instead of designed. If the result could be any AI app, it is not done.

## Hard rules (non-negotiable)

These are the tells that scream "an AI made this." Never do them.

1. No em-dashes or en-dashes. Use hyphens only (`-`, never `—` or `–`). Applies to all copy, headings, microcopy, alt text, and code comments shown to users.
2. No emojis. Not in copy, not as icons, not as bullets, not in headings. When an icon is needed, use a real SVG icon set (Lucide or Heroicons).
3. No gradients. Flat, intentional color only. No gradient backgrounds, gradient text, gradient buttons, or gradient "hero blobs." And do not reach for the default purple / indigo / violet "AI palette."
4. One consistent justification, left by default. Pick a single alignment and hold it down the whole page. Default to left-aligned text and left-aligned layout. Do not center everything - the centered hero plus centered three-card grid is the number-one AI tell. Center only when there is a real reason, such as a single empty state.

## Color

- Choose a small, deliberate palette that fits the product's domain and brand, not a default. A coffee roaster is warm and earthy; a fintech tool is restrained and precise; a law firm is sober and editorial. Derive the palette from the subject, not a template.
- One primary, one accent, and a neutral ramp chosen with intent (warm vs cool gray). Solid colors only. Meet WCAG AA contrast. No neon on white.

## Typography

- Use a real typeface with intent: a display plus text pairing, or one strong family used well. Do not default to Inter on everything.
- A deliberate type scale (for example a 1.25 ratio), generous body line-height (1.5 to 1.7), and tighter tracking on large headings.
- Left-aligned, ragged right. Never justify text. Hold body measure to roughly 65 to 75 characters.

## Layout

- A real grid with consistent gutters and a max content width. Align everything to it so left edges line up down the page.
- A spacing scale, not random pixels. Intentional whitespace and rhythm. Match density to the content: a data tool is dense, a landing page breathes.
- Design the actual screens this product needs. Do not reach for the centered hero plus feature grid plus CTA template unless the product genuinely is a simple marketing page, and even then make it specific to the brand.

## Components and states

- Real interaction states on everything interactive: hover, visible focus ring (keyboard users), active, disabled, loading.
- Real empty states, loading skeletons, and error states. Never a blank screen.
- Restraint over decoration. Prefer borders and spacing to heavy shadows. Do not put `rounded-2xl shadow-xl` on every card by reflex.

## Content

- Write real, specific copy for the actual product. No lorem ipsum, no "Welcome to X," no "Your all-in-one solution for...," no "Powered by AI."
- Concrete microcopy on buttons and states ("Save changes," "Find shops near me"), never generic ("Submit," "Click here").

## Before you finish: self-check

Scan the built UI and fix anything that fails:

- [ ] Zero em-dashes and en-dashes (hyphens only)
- [ ] Zero emojis (real SVG icons instead)
- [ ] Zero gradients, and not the default purple/indigo palette
- [ ] One consistent alignment, left by default, not centered-everything
- [ ] A real type scale and typeface, left-aligned body text
- [ ] Color and layout derived from THIS product, not a template
- [ ] Real copy and real states (hover, focus, empty, loading, error)

If it looks like it came from a template, redesign it before shipping.
