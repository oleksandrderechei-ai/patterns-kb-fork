---
title: Memento
description: Captures and restores an object's internal state
area: gof-behavioral
owner: Oleksandr Derechei
tags: [low-level-design, state-management, encapsulation]
status: stable
aliases: [Token, Snapshot]
solves: [I added a getter for every private field just so the save code could read them out, my undo tries to reverse each edit step by step and keeps getting it wrong, a multi-step update failed halfway and left the object in a half-changed state, the save code can now mutate internals that were supposed to be private, I need to snapshot an object before a risky change and roll it back if that fails]
---

# Memento

Captures a snapshot of an object's private state and stashes it away — so you can roll the object back to that exact point later, without ever exposing how it works inside.

## What it is
<!--meta block=description-->

You want undo or rollback for an object, but reading its state out would mean opening its private fields to everyone. A memento is a sealed snapshot that only the object itself can read: the object creates it, and a caretaker keeps the snapshots and hands them back without looking inside, so the object can restore itself.

## Explained
<!--meta block=explain-->

A memento is a sealed snapshot of an object's private state. The object itself creates it and can later restore from it, while whatever stores the snapshots is meant only to hold and return them, never to read inside. That gives you undo or rollback without making the object's fields public. Choose it over recording and reversing each change when the state is private and the restore must be exact. Where changes are small and frequent, recording only what changed costs less memory, at the price of a harder restore.

- **Memory.** Each snapshot is a full copy, so cost is object size times history depth. Drop old ones, for example keep only the last 50.
- **Shallow copies.** Copying only the top level shares inner objects with live state, so later edits leak into old snapshots. Copy inner objects too.
- **Limited reach.** A snapshot covers only the object, so a file written or a request sent stays done after a restore; undo those separately.

**Example.** A drawing holds 2,000 shapes at about 1 KB each, so 2 MB, and takes a snapshot before every edit. Keeping 50 snapshots costs 100 MB, so the history drops its oldest snapshot beyond 50. Your code copies the list of shapes but not the shapes inside it. You move shape 7 and undo, and the shape stays moved, because the snapshot and the live drawing share the same shape object. A test that moves a shape after the snapshot, restores, and checks the old position catches the bug.

## How it works
<!--meta block=structure-->

```mermaid caption="The originator snapshots its own state into a memento, the caretaker keeps it as an opaque token, and later the originator uses it to roll itself back."
sequenceDiagram
    autonumber
    participant O as Originator
    participant C as Caretaker
    participant M as Memento
    O->>M: save, capture private state
    O-->>C: hand off memento to hold
    Note over C: caretaker stores it, never inspects
    alt undo requested
        C-->>O: return memento
        O->>M: read saved state
        O->>O: roll state back
    else discarded
        C->>C: drop memento, no restore
    end
```

## Variations
<!--meta block=variations-->

- **Opaque vs. transparent state** — A true black-box memento exposes nothing to the caretaker; a looser transparent variant uses public fields for convenience and trusts callers not to abuse them.
- **Full vs. incremental snapshots** — Store the entire state each time, or record only the delta from the previous memento — incremental mementos save memory for large objects at the cost of replay to reconstruct.
- **Serialized / persistent mementos** — Marshal the snapshot to JSON, a blob, or disk so state survives a restart — the same shape underlies document autosave and crash recovery.
- **[Immutable snapshots](../../functional/immutability.md)** — Make the originator's state immutable and a memento becomes a mere reference to a shared version: nothing is copied at snapshot time, and undo is a pointer swap. Each edit builds a new version that shares the unchanged parts, and at this point you hold a version reference rather than a memento (see the avoid list in usage).

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **It saves and restores an object's state** without exposing its internals.
- **It keeps undo, checkpoint, and rollback logic** out of the object's core code.
- **Whatever holds the history** does so without knowing what's inside each snapshot.
- **Deep-copied full snapshots are self-contained**, so they are easy to stack, serialize or send elsewhere. Incremental ones need their predecessors, and no snapshot carries a live handle.

### Cons
<!--meta polarity=con-->

- **Taking a full snapshot of a large object** costs time and memory.
- **Something has to decide** when to drop old snapshots, or the history grows without bound.
- **Deep-copying mutable state** is easy to get subtly wrong — shared references leak between snapshots.
- **In languages with no way to let one class read another's private fields (a "friend")**, it is hard to keep a snapshot's contents private. Give the caretaker a type with no readable fields. Where the language cannot enforce that, privacy rests on convention.
- **A snapshot holds only the object's own state.** A collaborator it mutated, a file it wrote or a request it sent stays changed after the restore, and a handle it held must be re-acquired. Undo those effects separately, by recording and reversing each one ([Command](./command.md)).

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You need undo/redo**, checkpoints, or a way to roll back to a known-good state.
- **Capturing that state directly** would force you to expose fields that should stay private.
- **Something other than the object itself** should own and order the snapshots.

### Avoid when
<!--meta polarity=avoid-->

- **The state is trivial or already public** — a plain copy is simpler.
- **Snapshots would be big or frequent** enough to blow your memory budget. Record and reverse each change instead (Command), or store deltas (the incremental variation).
- **The state is already immutable**, so just keeping a reference to the old value is enough.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an editor whose undo history is opaque snapshots"
// The snapshot is an empty token; only the Editor can look up what it holds.
class EditorSnapshot {}
const saved = new WeakMap<EditorSnapshot, { content: string; cursor: number }>();   // module-private: never exported

class Editor {
  private content = "";
  private cursor = 0;
  type(text: string): void {
    this.content += text;
    this.cursor = this.content.length;
  }
  save(): EditorSnapshot {
    const snapshot = new EditorSnapshot();
    saved.set(snapshot, { content: this.content, cursor: this.cursor });   // capture full state
    return snapshot;
  }
  restore(snapshot: EditorSnapshot): void {
    const state = saved.get(snapshot)!;
    this.content = state.content;
    this.cursor = state.cursor;
  }
}

// The history keeps snapshots but never inspects their contents.
const editor = new Editor();
const history: EditorSnapshot[] = [];

editor.type("hello ");
history.push(editor.save());       // checkpoint
editor.type("world");
editor.restore(history.pop()!);    // undo, back to "hello "
```

## In the wild
<!--meta block=wild-->

- **Android saved instance state** — Before the system destroys an activity it may recreate later, it asks the activity to write its own state into a Bundle. The framework stores that Bundle without interpreting it and hands it back when the activity is rebuilt, so the activity alone reads the captured fields. {#wild-android-saved-instance-state}
- **ZFS snapshots** — A snapshot records a read-only, point-in-time image of a dataset, and a later rollback returns that dataset to exactly the recorded state. Snapshots are cheap enough to keep in sequence, which makes expiry policy — deciding which old ones to drop — a standing concern. {#wild-zfs-snapshots}
- **Virtual machine snapshots** — Hypervisors such as VMware and VirtualBox capture the state of a virtual machine — disk contents, and memory and device state when it is running — as a named snapshot, then revert the machine to that exact point on request. Whoever manages the snapshots treats each one as a single opaque unit. {#wild-hypervisor-snapshots}
- **CRIU (Checkpoint/Restore In Userspace)** — A Linux tool that freezes a running process tree, dumps its state to a set of files, and later restarts the processes from that dump. The dump is written and read back by the same mechanism rather than inspected by the caller. {#wild-criu}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **History depth** — How many mementos the caretaker retains. Unbounded history grows memory for the whole session; a ring buffer caps it at the cost of losing the oldest undo steps. Set the depth to the memory budget divided by one measured snapshot's size; for example, 2 MB snapshots and a 100 MB budget allow 50.
- **Full vs. incremental snapshots** — Store the whole state each time (fast restore, heavy memory) or only the delta from the previous memento (light memory, but restore must replay the deltas).
- **Snapshot frequency** — How often state is captured: per keystroke, per command, or on a timer. Finer granularity buys more undo resolution and costs more memory and copy time.

### Signals to watch
<!--meta polarity=signal-->

- **History memory footprint** — Total bytes held in retained mementos; it scales with snapshot size times history depth and is the first thing to watch on large documents.
- **Snapshot latency** — Time to deep-copy or serialize the state. On a large originator a full snapshot per action shows up as input lag.

### Failure modes under load
<!--meta polarity=failure-->

- **Unbounded history** — The caretaker never discards old mementos and memory climbs for the life of the session until it exhausts the budget.
- **Shared-reference leak** — A shallow snapshot captures references into the live mutable state, so a later mutation silently corrupts the stored memento and undo restores the wrong thing.
- **Snapshot cost under load** — Full snapshots of a large object taken too often dominate CPU, turning every edit into a copy of the entire state.
- **Restore leaves outside effects behind** — A restore returns the object's own state while a file it wrote, a request it sent or a handle it held is untouched or stale, so undo looks complete and the outside world disagrees.

### Readiness checklist
<!--meta polarity=check-->

- Memento history is bounded by a fixed depth or size cap so it cannot grow forever.
- Snapshots deep-copy mutable state so a later edit cannot mutate a stored memento, verified by a test that mutates after a save, restores and asserts the old value.
- Snapshot size and frequency are sized against the memory budget for large originators.
- Persistent or serialized mementos round-trip correctly across a restart if used for crash recovery, and carry a format version so one written by older code is migrated or refused, not restored.
- A restore test runs after an operation that touches outside state and checks what the restore does not undo.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Object Behavior](../../../themes/object-behavior.md) — Capture an object's state in a separate object so you can restore it later. {#fluency-object-behavior}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Command](./command.md) — Command does; Memento captures state to undo
- [Immutability](../../functional/immutability.md) — Immutable snapshots make undo trivial
- [Event Sourcing](../../architecture/event-sourcing.md) — Periodic snapshots cap how far back a replay has to start

<!-- relationships:end -->
