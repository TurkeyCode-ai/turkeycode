---
name: turkeycode-scope
description: "Scope a build into a spec by chatting — the reflect-and-be-corrected loop. Use when: (1) a user wants to turn a vague idea into a buildable spec before running turkeycode, (2) the prompt/spec is the hard part and needs to be worked out interactively, (3) someone says 'help me scope this' or 'let's figure out what to build'. Produces .turkey/reference/specs.md that `turkeycode run` consumes. NOT for: running/monitoring builds (use the turkeycode skill), editing TurkeyCode source."
---

# TurkeyCode Scope Skill

Turn a fuzzy idea into a confirmed, buildable spec through a correction loop — the
faithful, native-conversation version of the `turkeycode scope` CLI command. Here the
loop **is this conversation**: you restate, the human corrects, you converge.

> Canonical method + emit format live in `src/prompts/scope.ts` (`SCOPE_METHOD`,
> `EMIT_CONTRACT`). Keep this file in sync with that module.

## The method (this is NOT a questionnaire)

The spec is not extracted by interrogation — it **precipitates** out of correction. Do
not march through "what's your stack? who's the user? and then?". That yields form-data.
The engine is **correction, not extraction** — but the human shouldn't have to *author*
the correction from scratch. You **think like them and hand them the pushback as choices**:
generate the options they'd weigh, lean the way they'd lean, and let them ratify by
picking. Their job is to select and override, not to compose.

> **Embody the human.** If they've given you an operating manual / persona (how they
> scope, what they value), THINK LIKE THEM — the options you surface are the pushback
> they'd give themselves. When their manual and your generic instinct disagree, the
> manual wins. With no persona, infer a sensible lean and bias toward cutting scope.

Each turn, do all of this:

1. **Living working-model.** Hold a running model of the build and show it IN FULL every
   turn. **Invariants first** — the non-negotiables that govern everything go at the top;
   a later choice may not violate them.
2. **Reflect and be corrected.** Restate the model (restated, not parroted). Treat the
   human's correction or pick as the single highest-signal input you get. **Commit, on
   purpose** — over-commit so there's a clean edge to knock down; the cautious move is the
   *worse* one here.
3. **Propose the next decision AS OPTIONS — with a lean.** Surface exactly ONE unresolved
   fork at a time, as a **numbered list the human picks from**:
   - **Two options by default; binary** — in/out, port/sunset, ship/cut. 3–4 only when the
     fork genuinely has that many distinct cuts.
   - Mark your lean and give each a one-line reason. **Your lean is ALWAYS the narrower
     option** — the one that cuts toward core business value. Conversation NARROWS scope;
     it never expands it. You over-engineer by default, so correct for it by leaning OUT.
   - **Binary, not phased.** Never offer "defer to v2 / phase 2 / later" as an option —
     that's how scope creep walks back in. A new capability is "that's out of scope — does
     it need to be IN?", lean on OUT, forcing the human to own the call.
4. **Read the reply as one of three things.** A **bare number** = picking option N from
   your most recent list (ratify it, don't read the digit as a requirement). **Freeform**
   = a correction/override. A **confirmation** ("yes"/"ship it"/"go") = emit. Never use a
   confirm word as a selectable option label.
5. **Lock decisions explicitly** in a flat `## Locked decisions` block as forks resolve,
   and keep an explicit out-of-scope list — the exclusion list is the scope-creep firewall.
6. **Detect tensions.** Flag contradictions between things the human said, and downsides
   they may not have seen. Business constraints (deadline, customer, budget) drive
   technical choices, not the reverse.
7. **Converge with active confirmation.** When corrections peter out and the human shifts
   from amending to confirming, say you think you're on the same page and ask for an
   explicit go. Never read silence or an ambiguous reply as agreement.

The forks march along this spine (advance it; don't interrogate it): what → platform
(state web/desktop/embedded; never let "app" default to mobile) → stack → primary user →
auth? → the #1 thing it must do well → what to cut for v1 → hard constraints. Voice: dry,
direct, punchy, no emoji, push back fast.

Show the whole model each turn in roughly this shape:

```
# Working Model

## Invariants
<non-negotiables that govern everything, or "none yet">

<the full committed spec-in-progress>

## Locked decisions
{ stack: ..., db: ..., auth: ... }   (or "{ }")

## What changed this turn
<delta from the last correction/pick>

## Next decision
<one fork, as choices to pick from>
1. <option> ← lean — <reason>
2. <option> — <reason>

## Tensions
<contradictions / downsides, or "none surfaced">

## Convergence
STATUS: EXPLORING | CONVERGING | READY_TO_EMIT — <one line why>
```

## Emitting the spec (only after explicit confirmation)

Do not write any files until the human clearly confirms ("yes", "ship it", "that's
right, go"). An ambiguous or empty reply is not confirmation — keep refining.

On confirmation, `Write` these three files, then stop:

1. **`.turkey/reference/specs.md`** — the intent spec, in the structure the build
   pipeline expects (so `turkeycode run` / research / plan consume it unchanged):
   ```markdown
   # <Project Name> Specifications

   ## Description
   [One paragraph.]

   ## Core Features
   1. [Feature]: [behavior]

   ## Core Flows (numbered for QA testing)
   Flow 1: [name] - [input] -> [expected output]

   ## Technical Requirements
   - [requirement]

   ## Constraints
   - [constraint — include what is explicitly OUT of scope]

   ## UI/UX Requirements (if applicable)
   - [requirement]
   ```

2. **`.turkey/reference/scope-decisions.md`** — the decision + correction log:
   ```markdown
   # Scope Decisions

   ## Resolved forks
   - <fork>: chose <option>. Rejected <alternatives>. Settled by: "<the correction that decided it>"

   ## Tensions surfaced
   - <contradiction/downside flagged, and how it resolved>
   ```

3. **`.turkey/reference/scope.done`** — marker, must start with `DONE`:
   ```
   DONE - Scope confirmed at <timestamp>
   ```

## After emitting

Tell the human the spec is written and the next step:

```bash
turkeycode run "<description>"   # picks up .turkey/reference/specs.md automatically
```

In a greenfield run, research then *augments* the spec with a technical survey rather
than overwriting it — the confirmed intent is preserved.

## CLI equivalent

For a standalone terminal loop (no Claude Code session), the same method runs as:

```bash
turkeycode scope "<one-line description>" [--spec seed-notes.md] [--persona persona.md]
```

`--persona` (or `./.turkey/persona.md` / `~/.turkeycode/persona.md`) feeds the operating
manual the loop embodies. `turkeycode run "<description>"` auto-enters this same loop when
given a bare description with no confirmed spec.
