---
title: Hyrum's Law
description: "With enough users, every observable behaviour becomes a dependency, whatever the contract says"
area: principles-craft
owner: Oleksandr Derechei
tags: [api-design, maintainability, boundaries]
status: stable
aliases: [Law of Implicit Interfaces]
solves: [we changed behaviour the docs never promised and a client team broke, users parse our error message text and every wording change breaks them, callers rely on the order of results that we documented as unordered, a harmless internal refactor changed response timing and downstream code failed]
---

# Hyrum's Law

With enough users, every observable behaviour of your system becomes something somebody depends on, whatever the contract says.

## What it says
<!--meta block=description-->

Hyrum's Law, named for Google engineer Hyrum Wright, says that once an API has enough users, it does not matter what you promised in the contract: somebody depends on every observable behaviour. It is often read as a complaint about careless callers. It is really a statement about what a contract is: the documented promise plus everything else a caller can see, such as ordering, timing, error text and field names.

## Explained
<!--meta block=explain-->

Hyrum's Law says that a contract is not what you wrote down but everything a caller can observe. Once enough people use your API, someone depends on the order of results, the timing of a response, the wording of an error or an undocumented field, and your change to any of them breaks that someone. So you cannot treat the documentation as the full interface. Choose to shrink and shape what is observable over relying on warnings in the docs, because callers read behaviour, not prose. Return narrow types, give errors stable codes, and make unpromised behaviour vary, for example by shuffling unordered results in tests. Use [API versioning](../patterns/distributed/routing/api-versioning.md) and [contract tests](../patterns/testing/contract-testing.md) to find out who depends on what before you change it. The cost is effort and some noise in the code, which grows with the size of your user base.

**Example.** A search API documents results as unordered, but they come back sorted by id because of an index. Over 4 years, 3 of 40 client teams start using the first result as the oldest record. A database upgrade changes the plan, and the order flips. Three teams see wrong data and file bugs against an unbroken contract. If the API had shuffled unordered results in its test build, the 3 teams would have failed in their first week. The cost of that fix is one line and a more annoying test run, and the cost of not doing it was 3 incident reviews.

## Why it helps
<!--meta block=rationale-->

Without this law in mind, you treat the documentation as the whole interface. You change something the docs never mentioned, such as the order of results or the wording of an error, and call it safe. Then a caller who parsed that error text, or relied on that order, breaks, and from their side you broke the contract, because the contract they could see included it. The defect is in the gap between the promised interface and the observed one, and no test of the documented behaviour looks there.

Holding the law in mind shrinks the gap on purpose. You decide which behaviours you will stand behind, make the rest hard to depend on, and plan changes knowing that the real compatibility surface is larger than the spec. The larger the user base, the more of that surface is in use, so the cost of an unplanned change grows with success.

## Applying it
<!--meta block=applying-->

Shape what callers can observe, because you cannot control what they notice:

- **Expose less.** Return a narrow type instead of your internal object, and keep fields and helpers private, so there is less to depend on.
- **Make unpromised behaviour vary.** If order is not guaranteed, randomise or sort it differently in test builds, so callers who rely on it fail early instead of years later.
- **Give errors a stable code.** Callers will parse messages if that is all there is, so provide a machine-readable error code and treat the text as free to change.
- **Record what is promised.** Write down which behaviours are guaranteed and which are not, and link that note from the places callers look.
- **Plan breaking changes.** Use [versioning](../patterns/distributed/routing/api-versioning.md), deprecation periods and a contract test per consumer, so you learn who depends on what before you change it.

## In code
<!--meta block=sketch-->

```typescript summary="TypeScript — an unpromised order that callers start to rely on, and a fix that stops them"
// Before: the docs say "unordered", but the array happens to come back sorted by id.
function listUsers(db: Db): User[] {
  return db.query("SELECT * FROM users");        // today: id order, by accident of the index
}
// A caller takes users[0] as "the oldest". It works for years, then an index change breaks it.

// After: the unpromised order is made unreliable, and the promised one is explicit.
function listUsers(db: Db, opts: { order?: "id" | "created" } = {}): User[] {
  const rows = db.query("SELECT * FROM users");
  if (opts.order) return sortBy(rows, opts.order);   // order only when asked for
  return process.env.NODE_ENV === "test" ? shuffle(rows) : rows; // tests catch hidden reliance
}
```

## Taken too far
<!--meta block=overreach-->

You cannot freeze every observable behaviour. An API where no detail may ever change is one that cannot be fixed, sped up or made safer, so the law is a reason to choose which surface to protect, not a ban on change. Treating every accidental behaviour as a promise leaves you with a growing pile of promises you never meant to make.

Spend the effort in proportion to your user base. An internal helper with three callers needs a search and a message. A public library with thousands of users needs the narrow surface, the deliberate noise and the deprecation path. Applying the public-library discipline to a private module costs shuffles, wrappers and versions for callers you could simply update.

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Postel's Law](./postels-law.md) — Every observable behaviour gets depended on, including quirks a tolerant reader accepted
- [API Versioning](../patterns/distributed/routing/api-versioning.md) — A change that keeps the documented contract can still break callers, so versions need a deliberate policy
- [Contract Testing](../patterns/testing/contract-testing.md) — The contract is the promise plus what callers can see, so test what consumers really use
- [Encapsulation](./encapsulation.md) — Callers depend on whatever leaks out of an interface, so expose less
- [Principle of Least Astonishment](./least-astonishment.md) — What callers expect is what they will come to depend on.

<!-- relationships:end -->
