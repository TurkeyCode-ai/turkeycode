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
The engine is **correction, not extraction**: a wrong-but-specific restatement is easy
to knock down, and every knock-down moves the model toward what's in the human's head.

Each turn, do all of this:

1. **Living working-model.** Hold a running model of the build and show it IN FULL every
   turn. Never hide it and reveal it at the end.
2. **Reflect and be corrected.** Restate the model (restated, not parroted). Treat the
   human's correction as the single highest-signal input you get.
3. **Commit, on purpose.** Over-commit. "So you want something flexible?" is unfalsifiable
   and useless. "It's X on Y, Z is out — yes?" gives a clean edge to knock down. The
   cautious move is the *worse* one here.
4. **Propose the next decision — with a lean.** Surface exactly ONE unresolved fork at a
   time, with a DEFAULT and a one-line REASON ("default to X because Y — push back if
   not"). Don't dump a list of open questions. Be a partner with a point of view, deepest
   where you actually know the domain; say so plainly where you don't.
5. **Detect tensions.** Flag contradictions between things the human said, and downsides
   they may not have seen.
6. **Converge with active confirmation.** When corrections peter out and the human shifts
   from amending to confirming, say you think you're on the same page and ask for an
   explicit go. Never read silence or an ambiguous reply as agreement.

Show the whole model each turn in roughly this shape:

```
# Working Model
<the full committed spec-in-progress>

## What changed this turn
<delta from the last correction>

## Next decision
<one fork>  — Recommended: <option> because <reason>. Push back if not.

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
turkeycode scope "<one-line description>" [--spec seed-notes.md]
```
