---
name: frontend-design
description: "Design taste and hard rules for building app UIs that are hand-crafted and genuinely impressive, not AI-generated. Use whenever building or styling any web or app frontend - pages, components, layouts, marketing sites, dashboards, emails. Enforces no em-dashes, no emojis, no gradients, consistent left alignment, real type and color systems, and real content - and pushes for a real identity (logo, palette, type, motion), purposeful motion, and a voice matched to the domain. NOT for backend/API logic or build orchestration."
---

# Frontend Design

Build interfaces a senior product designer would be proud to ship, for THIS product specifically. The failure mode to avoid is the "AI-built app" look: generic, templated, the same every time, decorated instead of designed. If the result could be any AI app, it is not done.

The bar is not "works," and not even "doesn't look AI-made." The bar is **a product someone would be excited to use**: a coherent visual identity, motion that makes it feel alive, and a voice with a point of view. You reach that bar through craft and a strong identity - never through bolt-on effects. The Hard rules below are the floor (they prevent the AI-built look); the Identity, Motion, and Personality sections are the ceiling (they make it memorable). Both matter.

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

## Identity (give the product a face)

- Derive a cohesive identity from the product and its domain, then build everything to it: a logo, a palette, a typeface pairing, and a motion language that all feel like one thing.
- Generate a real **logo / wordmark** when the user did not provide one - a designed SVG mark, or a wordmark with intentional type and a small graphic element, NOT the app name set in the default font. The favicon is that mark, simplified. Never ship the framework default or a generic placeholder.
- Identity is consistency: the same accent, type, spacing, and motion on every screen. A user should recognize the app from any single screen.

## Motion (make it feel alive, with restraint)

- Add purposeful motion: entrance for content as it loads, smooth transitions on view/route changes, responsive hover/focus feedback, real loading states, and a beat of feedback on state changes (saved, added, removed).
- Restraint is the rule. Motion guides attention and confirms actions; it is never decoration. No bouncing, spinning, or animation for its own sake. Keep it quick (about 150-300ms) with real easing, not linear.
- Animate `transform` and `opacity` (cheap, smooth); avoid animating layout. Respect `prefers-reduced-motion: reduce` - drop or minimize motion when the user asks for it.
- A static page that never moves feels dead; gratuitous animation feels amateur. Aim for the small, tasteful in-between.

## Personality and voice (match the domain)

- Give the product a point of view, matched to what it IS. A kids' game is playful and loud; a finance or legal tool is calm, precise, and confident; a coffee app is warm and inviting. Let the domain set the boldness dial - within every Hard rule above.
- Carry that voice through the copy, especially the empty, loading, and error states - that is where personality lives. "No shops match your filters yet - widen your search" beats "No results."
- Give the app ONE signature moment: a detail, an interaction, or a piece of craft that makes someone smile or think "nice." One is enough - do not scatter gimmicks.
- Personality is earned through craft and voice. Never fake it with emojis, gradients, or noise (those are banned above).

## Before you finish: self-check

Scan the built UI and fix anything that fails:

- [ ] Zero em-dashes and en-dashes (hyphens only)
- [ ] Zero emojis (real SVG icons instead)
- [ ] Zero gradients, and not the default purple/indigo palette
- [ ] One consistent alignment, left by default, not centered-everything
- [ ] A real type scale and typeface, left-aligned body text
- [ ] Color and layout derived from THIS product, not a template
- [ ] Real copy and real states (hover, focus, empty, loading, error)
- [ ] A real logo / wordmark (not the app name in a default font); favicon matches it
- [ ] Purposeful, restrained motion (entrance, transitions, hover, loading); `prefers-reduced-motion` respected
- [ ] A clear voice matched to the domain, carried into the empty/loading/error states; one signature moment
- [ ] Hits the quality bar for its category, not the literal minimum

If it looks like it came from a template, redesign it before shipping. If it merely works but no one would be excited to use it, it is not done.
