---
title: Convention over Configuration
description: "Give every choice a sensible default, so users configure only where they differ"
area: principles-craft
owner: Oleksandr Derechei
tags: [api-design, maintainability, readability]
status: stable
aliases: [Coding by convention]
solves: [every new project needs the same forty lines of settings that nobody reads, setting up a new resource means editing four config files that must agree, two teams lay out the same kind of project differently and cannot move between them, most of our configuration just repeats the usual values]
---

# Convention over Configuration

Give every choice a sensible default, so users configure only where they differ from the usual.

## What it says
<!--meta block=description-->

Convention over configuration says a framework or tool should assume reasonable defaults, such as names, file locations and wiring, and ask for configuration only where the user departs from them. David Heinemeier Hansson popularised the phrase through Ruby on Rails. It is often read as "no configuration". It means the common case needs none, and the unusual case can still override the default.

## Explained
<!--meta block=explain-->

The tool finds your code by its name and place, so you write settings only for the exceptions. The default replaces a pile of settings that every project would otherwise write and keep in sync, so two projects on the same convention look alike. Rails does this when it maps a class named Order to a table named orders. Choose it over explicit configuration when most users want the same thing, and keep an override for the rest. The cost is that the convention is hidden: a newcomer cannot see why something is wired and may not find the setting to change it. Document the rule in one place, have the tool print what it inferred, and make the override one explicit line, in the spirit of [least astonishment](least-astonishment.md).

**Example.** A service framework needs a route, a handler and a table for each resource. By convention, a file named orders.ts holds the handler and gives the route /orders and the table orders, so a new resource is 1 file and no config entries. One legacy table is called tbl_ord, and a single line overrides the table name. The risk is the hidden rule: a developer cannot see why /orders exists, so the tool prints each inferred route at startup. A rename of the file would change the public URL, so public names are pinned in a test.

## Why it helps
<!--meta block=rationale-->

Without defaults, every project writes the same settings: where files live, what a table is called, which class handles which route. Each setting is a decision that must be made, written down, kept in sync and read by the next developer. The defect is the pile, not any one setting. Each looks trivial, so the pile often goes untested, and any one setting can be wrong in only one project.

A shared convention removes the pile. Two projects built on it look alike, so a developer moves between them without relearning the layout, and the tool can find your code by its name and place. The only configuration that remains is the part that differs from the norm, which makes it the part worth reading.

## Applying it
<!--meta block=applying-->

Design the default first and the knob second:

- **Choose defaults for the common case.** If most users name the table after the class, do that automatically and make the exception a single line.
- **Make the convention discoverable.** Document the rule in one place and make the tool print what it inferred, so users can see the result without reading source.
- **Keep an escape hatch.** Every default needs an override that is local and explicit, so one odd case does not force a fork.
- **Fail with a clear message.** When the convention is not followed, say which name or path was expected, for example `no table for Order: expected "orders"`, and name the override, since a silent mismatch leaves the user guessing which name or path was wrong.
- **Keep the convention stable.** Changing a default breaks every project that relied on it, so version it and announce it, and snapshot the inferred names (routes, tables) in a test so a change fails in review.
- **Review for the pile.** Delete any setting equal to its default; what remains are the real departures, each needing a reason. The same path or name string repeated across many entries signals a missing convention.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — three hand-written entries for orders, then one file name and a one-line override"
// Before: every resource repeats its name in route, handler and table entries.
const routes = { "/orders": "orders" };
const handlers = { orders: ordersHandler };
const tables = { orders: "orders" };

// After: the file name orders.ts is the convention.
// orders.ts -> route /orders, table "orders"   (defineResource: your framework's registration call)
export default defineResource({
  handler: ordersHandler,
});

// The one odd case overrides a single value.
export default defineResource({
  handler: ordersHandler,
  table: "tbl_ord",
});

// Startup prints each inferred name, marking default or overridden.
// /orders -> table "tbl_ord" (overridden)
```

## Taken too far
<!--meta block=overreach-->

Conventions work as hidden configuration, and being hidden is the cost. A newcomer cannot see why a class is wired to a route, because the reason is a naming rule in a framework they have not learned, and when the rule is wrong for them they may not find the setting. The more that is implicit, the more rules a newcomer must learn before the code makes sense. When the name is the wiring, a rename can silently change public URLs, tables and stored data, so pin public names explicitly or test the inferred map.

The other failure is the missing escape. A convention with no override forces users to fight the tool or abandon it for the one case that does not fit. Make the default cover most cases, make the override cheap, and log what the convention chose, so the invisible choice can still be checked.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Principle of Least Astonishment](./least-astonishment.md) — A default that follows the common expectation needs no setting
- [Keep It Simple (KISS)](./kiss.md) — The common case needs no configuration at all
- [Dependency Injection](../patterns/gof/extra/dependency-injection.md) — A container can wire components by naming and location rules, with no wiring file
- [MVC](../patterns/architecture/mvc.md) — Rails-style frameworks find controllers, views and models by name and folder
- [External Configuration Store](../patterns/distributed/coordination/external-configuration-store.md) — Keeps the settings few, so the departures from the default are the only ones to store
- [Hyrum's Law](./hyrums-law.md) — A default users rely on becomes a contract, so changing it breaks them.

<!-- relationships:end -->
