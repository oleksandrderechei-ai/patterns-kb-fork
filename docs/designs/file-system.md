---
title: File System
description: "A tree of files and folders behind one path-based API — an object-oriented design about where identity, containment, and path logic each belong"
area: designs-foundational
owner: Oleksandr Derechei
tags: [low-level-design, composition, abstraction, encapsulation]
status: stable
aliases: [in-memory file system, directory tree]
solves: [renaming a top-level folder forces me to rewrite the stored path on thousands of items underneath it, finding a child by name means scanning the whole list of siblings on every lookup, my two node classes keep duplicating the same name and parent-pointer code, external callers have to walk my tree and stitch path strings together themselves, "two threads both check that a name is free and both create it, and one silently overwrites the other"]
---

# File System

An in-memory file system is a Finder-like hierarchy with the disk taken away — no persistence, no I/O, no caching, just the data structures and the operations over them. As a low-level design it turns on three quiet questions: how an entry knows its own path, how a folder finds a child, and who is allowed to touch the tree.

## Understanding the problem
<!--meta block=description-->

An in-memory file system has one Unix-style root, folders that nest arbitrarily and files that hold string content. Callers create, delete, list, resolve absolute paths, rename and move. With no disk there is no persistence or I/O to design, so the page is object modelling: name the classes, give each its state and behaviour, and keep the tree fast at tens of thousands of entries.

## Explained
<!--meta block=explain-->

An in-memory file system is a tree where every file and folder shares one base type holding its name and a link to its parent folder. A folder keeps its children in a map keyed by name, and one outer object parses every path string so callers never touch the tree. The full path is computed by walking up the parent links instead of being stored, so renaming or moving a folder changes one entry, not every file beneath it. The map makes each lookup near-constant-time per path segment (average case) at any folder size, and a duplicate sibling name is caught by one key check. Leave search and path caching until asked, since each is an index you must keep in sync.

- **Paired links.** Parent and child links must change together, or the computed path is wrong. A rename removes the old key and adds the new.
- **Cycles.** A move can make a folder its own descendant. Walk up from the destination and refuse if you meet the moved entry.
- **Lock order.** One lock per folder lets different folders work at once; take two locks in a fixed order so opposite moves cannot deadlock.

**Example.** A folder /home holds 10,000 entries below it. If every entry stored its path as text, renaming /home to /house would rewrite 10,000 strings. With parent links it changes one name, and each entry's path is computed on demand by walking up about 10 to 20 levels. Now move /home to /home/user/stuff/home: the walk starts at the new parent /home/user/stuff, goes up to user, then reaches /home, the entry being moved, so the system refuses.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. One Unix-style root; folders nest without limit, files are always leaves and store string content.
2. Create and delete files and folders at an absolute path.
3. List a folder's contents, and resolve any absolute path to the entry it names.
4. Rename and move files and folders.
5. Compute the full path of any entry from a reference to it.

Out of scope: search, relative paths (`../`, `./`), permissions and ownership, timestamps, symbolic links, persistence, and any UI — the core is the tree and the operations over it.

### Non-functional (constraints)
<!--meta requirement=nfr-->

- **Responsiveness** — tens of thousands of entries and deep hierarchies; lookups must stay fast whatever a folder's fan-out.
- **Uniqueness** — no two entries in the same folder may share a name.
- **Explicit errors** — every failure raises a named exception rather than returning a sentinel: a missing entry or parent, a name collision, and an illegal request such as listing a file or deleting the root.
- **Encapsulation** — only the file system is public; a folder's child collection stays private behind its own methods.

## Core entities
<!--meta block=entities-->

Three classes and one shared base — plus one thing that looks like an entity but isn't:

- **FileSystem** — the orchestrator and the only public surface. It owns the root, parses path strings, and exposes the whole API. External code never navigates the tree: it passes path strings. Entry values returned by get, list and create are handles to be treated as read-only; callers do not call addChild or removeChild.
- **FileSystemEntry** — the abstract base every node shares: a `name`, a `parent` pointer, `getPath()`, and an abstract `isDirectory()`. It exists because a File and a Folder have the same identity and differ only in containment.
- **Folder** — the composite. A private `name → entry` map of children, exposed only through `addChild`, `removeChild`, `getChild`, and `getChildren`.
- **File** — the leaf. A name and a string `content`, with no children and no containment logic.
- **Path — not a class.** It is a string the caller passes in, with no state of its own, so it stays a parameter. Promoting it to an entity would be modelling something that never has an owner.

## The interface
<!--meta block=interface-->

The file system exposes seven path-based operations. Callers only ever pass absolute path strings; splitting them, walking the tree, and validating each step happen behind this door. Every method raises a specific exception rather than returning a sentinel:

```python summary="Pseudocode — the public API"
class FileSystem:
    createFile(path, content) -> File          # create a leaf; raises on bad path / collision
    createFolder(path)        -> Folder        # create a directory; raises on collision
    delete(path)              -> None          # remove an entry and its subtree; raises if absent, or if path is the root
    list(path)                -> list[Entry]   # a folder's children; raises if path names a file
    get(path)                 -> Entry         # resolve an absolute path; raises if not found
    rename(path, newName)     -> None          # rename in place; raises on collision
    move(srcPath, destPath)   -> None          # relocate; raises if it would nest a folder in itself
```

## How the system is built
<!--meta block=architecture-->

The file system holds a single root Folder and nothing else. Every operation resolves a path string to an entry by walking from the root, doing one map lookup per segment. File and Folder inherit from an abstract `FileSystemEntry`, which is what lets a folder's child map be typed as `name → FileSystemEntry` and lets the code above treat leaves and composites uniformly. Each entry carries a `parent` pointer, so its full path is computed by walking up to the root rather than stored — the single decision the whole design hangs on. Three private helpers — `resolvePath`, `resolveParent`, and `extractName` — keep all the string parsing in one place.

```mermaid caption="File and Folder share one abstract base, so the tree is a single type to the code above it. Each entry points back at its parent, which is how a path gets computed instead of stored."
classDiagram
    class FileSystem {
        -Folder root
        +createFile(path, content) File
        +createFolder(path) Folder
        +delete(path) void
        +get(path) FileSystemEntry
        +list(path) List~FileSystemEntry~
        +rename(path, newName) void
        +move(srcPath, destPath) void
    }
    class FileSystemEntry {
        <<abstract>>
        -String name
        -Folder parent
        +getName() String
        +getPath() String
        +isDirectory() bool
    }
    class File {
        -String content
        +getContent() String
        +isDirectory() bool
    }
    class Folder {
        -Map~String,FileSystemEntry~ children
        +addChild(entry) bool
        +removeChild(name) FileSystemEntry
        +getChild(name) FileSystemEntry
        +getChildren() List~FileSystemEntry~
        +isDirectory() bool
    }
    class InvalidPathException
    class NotFoundException
    class AlreadyExistsException
    FileSystemEntry <|-- File : is a
    FileSystemEntry <|-- Folder : is a
    FileSystem "1" o-- "1" Folder : owns root
    Folder "1" o-- "*" FileSystemEntry : children by name
    FileSystemEntry "*" --> "0..1" Folder : parent
    FileSystem ..> InvalidPathException : raises
    FileSystem ..> NotFoundException : raises
    FileSystem ..> AlreadyExistsException : raises
```

## Deep dives
<!--meta block=deepdives-->

### 1 · Store the path, or store the parent?

Every entry must be able to answer "what is my full path?" — and how it answers decides what rename and move cost.

- **Store the path string.** `getPath()` is then O(1) — return the field. But renaming `/home` to `/house` means rewriting the stale prefix on every descendant underneath it, which at "tens of thousands of entries" could be thousands of string updates. Move has the same defect. Rename and move become O(n) in the size of the subtree.
- **Store a parent pointer (chosen).** Keep only a link to the containing folder; `getPath()` walks up to the root, concatenating names. Now rename and move touch only the moved entry — its name or its parent — and every descendant resolves the correct path automatically because paths are computed, never cached. The cost is that `getPath()` is O(depth), but trees run maybe 10–20 levels deep, so it is negligible; memoize the string only if a profiler ever demands it. The one catch: parent and child now reference each other, so both links have to move in lockstep.

```python summary="Pseudocode — a path computed by walking up"
getPath():                       # on FileSystemEntry
    if parent is None:
        return name              # the root is constructed as Folder("/")
    parentPath = parent.getPath()
    if parentPath == "/":
        return "/" + name        # avoid the leading "//"
    return parentPath + "/" + name
```

### 2 · How a folder finds a child

Path resolution is a sequence of by-name child lookups: to reach `/home/user/docs` you find `home` in the root, then `user`, then `docs`. The collection type inside a folder decides how fast that is.

- **A list of children.** `getChild(name)` is a linear scan. A folder holding 10,000 files is up to 10,000 comparisons per segment, multiplied across every level of every path — it fails the responsiveness bar outright.
- **A map from name to entry (chosen).** Lookup is O(1) no matter the fan-out, so a folder with ten children and one with ten thousand resolve equally fast. The map earns a bonus: because its keys are unique, it is the "no two siblings share a name" rule — the map makes a duplicate name detectable with one key lookup; create, rename and move must still make that check and raise on a collision.

Each path segment is one map lookup, so depth costs steps and fan-out costs nothing.

```mermaid caption="How does /home/user/docs resolve, and why does a folder's size not slow it down?"
flowchart LR
    Root["root Folder"] -->|"getChild(home), O(1)"| H["home"]
    H -->|"getChild(user), O(1)"| U["user"]
    U -->|"getChild(docs), O(1)"| D["docs"]
```

### 3 · One tree, two kinds of node

File and Folder both have a `name`, a `parent`, a `getName()`, and a `getPath()`; they differ only in that folders contain children and files don't. A bare interface fixes the typing — it lets `children` be a `Map<String, FileSystemEntry>` — but shares no implementation, so each class re-declares the same fields and methods. An **abstract base class** shares both the fields and the behaviour: `File` is the leaf, `Folder` the composite, and `FileSystemEntry` the common base — the [Composite](../patterns/gof/structural/composite.md) pattern, reached not by naming it but by noticing the shared identity and the single real difference. Inheritance earns its place here precisely because the usual tests hold: genuine shared behaviour, a stable contract, and an honest is-a. Each subclass overrides only `isDirectory()`. Pulling the base out is also where [the duplication](../principles/dry.md) disappears, and it puts [separation of concerns](../principles/separation-of-concerns.md) on a clean footing — identity in the base, containment in Folder, content in File, orchestration in FileSystem, each with a [single reason to change](../principles/single-responsibility.md).

### 4 · One door, not many

The tempting shortcut is to make the root Folder public and let callers navigate it. But then every call site re-implements the same work: to create `/home/user/docs/report.txt` a caller must split the path, walk `root → home → user → docs`, handle a missing intermediate, and only then create the file — the identical logic copy-pasted across the codebase, and no single entry point to hold the rules. `FileSystem` is instead a [facade](../patterns/gof/structural/facade.md): it owns the root and all the path parsing, so callers pass a string and never touch the tree. Path handling lives in exactly one place, which is the same Don't Repeat Yourself (DRY) win from the other side.

### 5 · Moving without making a loop

Move is the one operation that touches two folders, and it can quietly corrupt the tree: moving `/home` into `/home/user/stuff` would make `/home` a descendant of itself. Guard it by walking up from the destination's parent toward the root — if that walk ever reaches the entry being moved, reject the move. Rename hides a subtler bug: because a folder's map is keyed by name, you cannot just call `setName()` in place, or the entry is left stranded under its old key. Remove it under the old key, rename it, then re-add it under the new one.

```python summary="Pseudocode — the cycle check inside move"
move(srcPath, destPath):
    entry      = resolveParent(srcPath).getChild(extractName(srcPath))
    destParent = resolveParent(destPath)

    if entry.isDirectory():          # can't move a folder into its own subtree
        node = destParent
        while node is not None:
            if node is entry:
                raise InvalidPathException("cannot move a folder into itself")
            node = node.getParent()

    # ... collision check at destination, then remove-from-src and add-to-dest ...
```

```mermaid caption="What gates a move, and how does it reject a cycle or a name collision?"
flowchart TB
    Start["move(srcPath, destPath)"] -->|"resolve entry + destParent"| Cyc{"folder moved under itself?"}
    Cyc -->|"walk up hits entry"| RejC["reject: InvalidPathException"]
    Cyc -->|"clear"| Col{"name taken at destination?"}
    Col -->|"yes"| RejN["reject: AlreadyExistsException"]
    Col -->|"no"| Apply["remove from src, add to destParent"]
    Apply -->|"both parent links updated"| Done["moved"]
```

### 6 · Making it thread-safe

As written the design assumes a single thread, and the create path is a classic check-then-act [race](../hazards/race-condition.md): two threads both see a name is free, both add it, and one silently overwrites the other. The pragmatic fix is a [monitor](../patterns/concurrency/monitor-object.md) — wrap each public method in `synchronized(this)`. It is correct and simple, but it serialises unrelated work: two creates in different folders block each other for no reason.

Fine-grained locks (one per folder, taken only on the folder being changed) restore that concurrency, but they make move dangerous — it holds two folder locks, and two moves in opposite directions [deadlock](../hazards/deadlock.md). The remedy is lock ordering: always acquire the two folder locks in a fixed order by a stable key, such as an immutable per-entry id, regardless of which is source and which is destination. Path strings are a poor key: a concurrent rename or move changes them while locks are held. Re-run the cycle check after both locks are held, since another thread may have re-parented a folder meanwhile.

Reads are the easy win: `get` and `list` mutate nothing, so a [read-write lock](../patterns/concurrency/rw-lock.md) lets them run concurrently and reserves exclusivity only for writers.

### 7 · Adding search later

Search is out of scope but the obvious next ask, and the base class makes it cheap to bolt on. A plain recursive traversal is O(n) over the whole tree. Trading space for time, a `name → entries` index on the file system turns find-by-name into O(1), at the cost of keeping it in sync on every create, delete, and rename; a trie over names extends that to prefix search. None of it forces a restructure — it hangs off the existing tree.

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- Parent pointers make rename O(1) and move O(depth of the destination) for the cycle check, both independent of subtree size — no path-rewriting cascade through the subtree.
- The name → entry map gives O(1) child lookup at any fan-out and makes a sibling-name collision cheap to detect: one key lookup, which create, rename and move must make and raise on.
- One shared base ends the duplicated identity code and lets every operation treat files and folders uniformly.
- A single facade owns path parsing, so callers never navigate the tree or hold folder references.

### What it gives up
<!--meta polarity=con-->

- `getPath()` recomputes on every call (O(depth)); cheap in practice, but memoizing it adds a cache to invalidate on every move.
- Parent and child references are bidirectional — add, remove, and move must update both sides or `getPath()` silently breaks.
- The model is single-threaded; safety is bolted on with locks, and move needs multi-lock ordering to avoid deadlock.
- No search without a secondary index; find-by-name is an O(n) tree walk until you pay to maintain one.

## What's expected at each level
<!--meta block=levels-->

- **Junior** — models the tree correctly (a FileSystem entry point over File and Folder nodes), gets create, delete, and path parsing working, reaches for a by-name child lookup (a map is ideal, a list is tolerated), and handles the obvious errors — a missing path, a name collision. The shared base class is not expected without a prompt.
- **Mid-level** — separates concerns without being told (FileSystem parses and orchestrates and nothing else), extracts `FileSystemEntry` after spotting the duplicated name/parent/`getPath()` code, explains why a parent pointer beats a stored path string, and updates parent pointers correctly on move; may need a nudge toward the cycle check.
- **Senior** — volunteers the parent-pointer trade-off and the cycle check unprompted, raises thread-safety on their own (the check-then-act race, locking two folders for a move, lock ordering for deadlock), and has extensions ready — a name index or trie for search, symlinks or permissions slotting onto the base class without a rewrite.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Exposed to**

- [Race Condition](../hazards/race-condition.md) — create is a check-then-act race: two threads both see a name free and one silently overwrites the other, corrupting the shared tree.
- [Deadlock](../hazards/deadlock.md) — move holds two folder locks, so two moves in opposite directions wait on each other until locks are taken in a fixed order.

**Demonstrates**

- [Composite](../patterns/gof/structural/composite.md) — File is the leaf, Folder the composite, and FileSystemEntry the shared base, so the tree is one type to the code above it
- [Facade](../patterns/gof/structural/facade.md) — FileSystem owns the root and all path parsing, so callers pass a string and never navigate the tree or hold folder references
- [Don't Repeat Yourself (DRY)](../principles/dry.md) — one FileSystemEntry base ends the duplicated name/parent/getPath code, and path parsing lives in exactly one place instead of at every call site
- [Separation of Concerns](../principles/separation-of-concerns.md) — identity lives in the base, containment in Folder, content in File, and orchestration in FileSystem
- [Single Responsibility Principle](../principles/single-responsibility.md) — File changes only for content, Folder only for containment, FileSystem only for path orchestration
- [Read-Write Lock](../patterns/concurrency/rw-lock.md) — get and list mutate nothing, so a read-write lock lets reads run concurrently while writes take the lock exclusively
- [Monitor Object](../patterns/concurrency/monitor-object.md) — the pragmatic thread-safe version wraps each public method in a synchronized(this) monitor

<!-- relationships:end -->
