---
title: Separation of Concerns
description: "Divide a system so each part addresses one distinct concern, understood in isolation"
area: principles-craft
owner: Oleksandr Derechei
tags: [modularity, separation-of-concerns, maintainability]
status: stable
aliases: [SoC]
solves: [my UI code is tangled with SQL queries and business rules in the same function, I can't test the business logic without spinning up the database and the web server, changing how a screen looks means editing the same file that talks to the database, "one class validates, renders, and persists and I can't touch one part without the others", fixing a display bug broke the billing calculation that lived right next to it]
---

# Separation of Concerns

Cut a system so that each part deals with one aspect — how it looks, what the rules are, where the data lives — and no more. Kept apart, each concern can be reasoned about, changed, and tested largely on its own; braided together, none of them can.

## What it says
<!--meta block=description-->

A concern is one coherent aspect of what a system must do, such as presentation, business rules, persistence, validation or transport. Organise code so each concern is addressed in its own place and no part is entangled in another. Edsger Dijkstra coined the phrase in 1974, describing the value of focusing attention on one aspect in isolation. Layering, module boundaries and model-view-controller are particular ways of drawing these lines.

## Explained
<!--meta block=explain-->

Separation of concerns says to put each aspect of what the system does, such as presentation, business rules, persistence or validation, in its own place, so you can read and change one without the others crowding in. Mix them and a change to a page layout touches SQL, and testing a pricing rule needs a database. Make each boundary a real seam you can swap or test against, such as a module, a layer or an interface, not a comment. Choose it over keeping everything together when two parts change for different reasons or at different speeds. Concerns that touch every part, such as logging and security, cannot be localised by any line, so apply one decision across many call sites with middleware on the request path or a decorator around the operation.

- **Ceremony.** A boundary with no real seam makes one new field hop through five layers, so add a boundary only where a seam pays.
- **Wrong cuts.** A boundary drawn before you know what varies together fights every change that crosses it, so let the seams show themselves first.

**Example.** A signup handler validates the email, writes SQL and builds the HTML reply in one long function. Changing the confirmation page means editing code that also writes to the database, and testing the email rule needs a running Postgres. The team splits out validate(email), a UserRepository and a template, and the validator is now tested with no database. They stop there. A teammate proposes a controller, service, mapper, data transfer object (DTO) and repository chain per field, which would mean 15 files for a 3-field form, so one handler keeps calling those three pieces. Request logging goes into one middleware instead of every function.

## Why it helps
<!--meta block=rationale-->

Entanglement compounds with the number of aspects sharing a module. Each aspect is one more reason to edit the same lines, so unrelated work collides in review and in merge, and a change made for one aspect carries risk to the others it never meant to touch. Two teams end up owning one file, and neither can move without waiting for the other.

Draw the boundaries and each concern gets its own room. A change to how something looks stays in the presentation layer; a change to a rule stays in the domain; the database can be swapped behind an interface the rest never sees. You can test the rules without a web server and the persistence without a browser, because each part depends on what its neighbour does, not how.

## Applying it
<!--meta block=applying-->

Name the concerns, then keep them from leaking into each other:

- Keep domain logic free of I/O: no SQL, no HTTP, no HTML in the code that decides what is true. Push those to the edges: pass data in as arguments, return a decision, and let an edge function read and write.
- Separate presentation from the model: the view renders state, the model holds it, and neither reaches across into the other's job.
- Put persistence behind an interface so the rest of the system asks for data without knowing whether it comes from Postgres, a file, or a mock.
- Make the boundary a real seam (a module, a layer, a port) that you can substitute or test against, not a comment. The domain owns the interface; the database adapter imports it, never the reverse.
- Review smells: a domain file imports a database driver or HTTP client; one function builds HTML and runs SQL; a rule test needs a running service; one feature's diff edits SQL, markup and a rule together.

The signal you have it right: you can describe each part in one sentence without the word “and.”

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — a signup handler mixing email check, SQL and HTML, then split into a validator, a repository and a template"
// Before: one function holds three concerns.
export async function signup(email: string, db: Db) {
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return "<p>Bad email</p>"; // breach: rule + HTML
  await db.query("INSERT INTO users(email) VALUES ($1)", [email]);   // breach: SQL
  return "<h1>Welcome " + email + "</h1>";                            // breach: HTML
}

// After: the rule is pure; storage and page each have one home.
// validate.ts
export const validate = (email: string) => /^[^@\s]+@[^@\s]+$/.test(email);
// users.ts
export interface UserRepository { add(email: string): Promise<void>; }
// pages.ts
export const welcomePage = (email: string) => `<h1>Welcome ${email}</h1>`;
export const badEmailPage = () => "<p>Bad email</p>";
// signup.ts
export async function signup(email: string, users: UserRepository) {
  if (!validate(email)) return badEmailPage();
  await users.add(email);
  return welcomePage(email);
}
```

## Taken too far
<!--meta block=overreach-->

Boundaries have a cost, and drawing them where no real seam exists is its own kind of mess. Over-partitioning slices cohesive logic across artificial layers, so that a single conceptual change — add one field — has to hop through a controller, a service, a mapper, a DTO (data transfer object), and a repository, each contributing a line of ceremony and nothing else. That is not separation of concerns; it is one concern smeared across five files.

Another failure is chasing concerns that will not sit still. Logging, security, error handling and performance turn up in every part of the system, and no line you draw localises them — cut finer and you get the same code in more places, plus the boundaries you added to hold it. For those, stop looking for the right seam and reach for a mechanism that applies one decision across many call sites: middleware on the request path, a decorator around the operation, an aspect woven in at build time. The concern is still separated; it is just separated by interception rather than by location.

A last failure is separating too early. Before you understand where the concerns actually fall, any line you draw is a guess, and a wrong boundary is worse than none — it fights every change that crosses it. Let the seams reveal themselves as the code tells you what varies together and what varies apart, then cut along those lines rather than the ones an architecture diagram predicted.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Layered / N-Tier](../patterns/architecture/layered.md) — Layers are one concern per tier — presentation, domain, persistence.
- [MVC](../patterns/architecture/mvc.md) — Model, view, and controller are three concerns kept deliberately apart.
- [Keep It Simple (KISS)](./kiss.md) — Keeping concerns apart is what makes a design simple rather than merely short
- [Command-Query Separation](./command-query-separation.md) — Command-query separation is one small case of it.
- [High Cohesion, Low Coupling](./high-cohesion-low-coupling.md) — Separating concerns is how a module gets cohesive
- [MVP](../patterns/architecture/mvp.md) — MVP applies it to a screen: view, presenter and model each own one concern
- [Container / Presentational](../patterns/frontend/container-presentational.md) — Container/presentational applies it to a component that fetches and draws

**Generalizes**

- [Single Responsibility Principle](./single-responsibility.md) — The class-level case of the general idea: one module, one concern, one reason to change.

**Prevents**

- [Big Ball of Mud](../hazards/big-ball-of-mud.md) — Clear concern boundaries are precisely what a big ball of mud has dissolved.
- [Spaghetti Code](../hazards/spaghetti-code.md) — Keep each concern in its own place and control flow stops threading through everything.
- [Shotgun Surgery](../hazards/shotgun-surgery.md) — Each concern in one place means a change to it is one edit.

**Demonstrated by**

- [Parking Lot](../designs/parking-lot.md) — Parking Lot centralises pricing and occupancy in the lot, keeping data classes simple
- [Robinhood](../designs/robinhood.md) — splitting lifecycle-of-record from delivery-resilience keeps each responsibility independently ownable and scalable
- [CamelCamelCamel](../designs/camelcamelcamel.md) — splitting read-heavy chart serving from scheduled write-heavy crawling shows concerns separated along their load shapes
- [Elevator](../designs/elevator.md) — coordination and movement are kept in separate classes so each can evolve without disturbing the other
- [Amazon Locker](../designs/amazon-locker.md) — the design draws the line between a physical condition and a system-managed relationship and places each where it belongs
- [Connect Four](../designs/connect-four.md) — Splitting win detection from turn enforcement into distinct classes is exactly the concern boundary this principle prescribes
- [File System](../designs/file-system.md) — each responsibility gets its own class rather than one node type doing everything
- [Logging Service](../designs/logging-service.md) — splitting a job into single-purpose collaborators so each changes for one reason is separation of concerns
- [Inventory Management](../designs/inventory-management.md) — the design keeps coordination and per-location state in distinct objects with non-overlapping responsibilities
- [BookMyShow](../designs/bookmyshow.md) — layering orchestration above state above records keeps every mutation in one lockable place

<!-- relationships:end -->
