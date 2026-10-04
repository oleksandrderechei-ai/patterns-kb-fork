---
title: DTO
description: Flat object for carrying data across a boundary
area: enterprise
owner: Oleksandr Derechei
tags: [api-design, boundaries, decoupling]
status: stable
aliases: [data transfer object]
solves: [my API response accidentally leaked a password hash to the client, rendering one screen fires forty tiny requests to fetch each field, renaming an internal field silently broke every mobile client, serializing my entity blows up on a circular reference, the JSON I return drags the entire object graph along with it]
---

# DTO

Carries data across a process or network boundary as a flat bag of fields — no behavior, no domain rules baked in, just the shape the far side agreed to.

## What it is
<!--meta block=description-->

Passing domain objects across a boundary leaks internal fields, and over a network it can force a call per getter. A DTO (data transfer object) is a plain, flat object that only carries data across a network call, message or screen. It holds fields and no business rules, and its shape follows what the boundary needs, so one call carries everything the caller wants and nothing more.

## Explained
<!--meta block=explain-->

A data transfer object, or DTO, is a plain flat object that only carries data across a boundary, such as a network call, a message or a screen. Its shape comes from what the boundary needs, not from how your domain objects are built. One call returns one DTO holding everything the caller needs, so you avoid many small round trips. Callers see only the fields the contract promises, with no internal proxies, private fields or behaviour. Any request body, message payload or serialized shape counts, whether or not the call is truly remote. Choose it over passing the domain object itself whenever the two sides should not share one internal type. When everything runs in one process, pass the domain object and skip the copy.

- **Repeated fields.** The DTO copies fields the domain object has, and the mapping is dull, so generate it or write one mapper per DTO.
- **Silent drift.** A new entity field is missing from the DTO, so fill every field in a mapper test and list deliberate omissions.
- **Creeping logic.** Logic in a DTO makes it a second domain model, so keep it a bag of values.

**Example.** An order screen needs a customer name, a total and 3 line items with a name and a price each. Fetched one getter at a time over an 80 ms round trip, that is 1 + 1 + 3 x 2 = 8 calls, about 640 ms. One OrderSummary DTO fetches it all in 1 call, 80 ms. The domain Order also holds a cost price, which the DTO leaves out, so clients never see it. Later the team adds a currency field to Order and forgets the DTO. A mapper test that fills every Order field, minus the cost price, now fails until the DTO carries currency. The cost is that second class and its mapper.

## How it works
<!--meta block=structure-->

~~~mermaid caption="Which fields cross the boundary, and in how many trips? The assembler copies only what the contract promises (2–3), so `passwordHash` never leaves the process, and the whole payload crosses in one trip (4) instead of a getter at a time."
flowchart LR
    subgraph Svc["Service process — the domain stays here"]
        DB[("Users table")]
        Dom["User aggregate:<br/>id, email, roles, passwordHash"]
        Asm["Assembler"]
        Dto["UserDto: id, email, roles"]
    end
    Client["Browser client"]:::ext
    Model["Client-side model"]:::ext
    DB -->|"1 load rows"| Dom
    Dom -->|"2 copy promised fields"| Asm
    Asm -->|"3 build"| Dto
    Dto -->|"4 serialize, one round trip"| Client
    Client -->|"5 deserialize"| Model
    classDef ext stroke-dasharray:4 4
~~~

## Variations
<!--meta block=variations-->

- **Request DTO / Response DTO pair** — Separate shapes for what a call accepts and what it returns, instead of one shared type. This keeps write-only fields out of the read shape and vice versa.
- **Assembler (or Mapper)** — A dedicated function or class that converts between domain object and DTO in one place, so mapping logic doesn't spread across controllers or leak into either shape.
- **Aggregate / coarse-grained DTO** — Bundles several related entities — an order plus its line items and customer — into one shape, answering a whole screen or call in a single round trip.
- **[Versioned](../distributed/routing/api-versioning.md) DTO** — The wire shape is versioned independently of the domain model (`UserDtoV2`), so an API keeps old clients working while the internal model moves on.
- **[Immutable](../functional/immutability.md) / record DTO** — Fields are readonly and set once at construction, a plain record with no setters, so a DTO cannot change after it crosses the boundary.
- **Projection DTO** — A read query selects only the needed columns straight into the DTO, skipping the domain object and its mapper for read-only screens.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Decouples the wire or API shape** from the internal domain model, so the model can change behind the mapper without touching clients.
- **Batches data into one coarse-grained call**, cutting chatty round trips when each call crosses a network.
- **Plain data with no behavior** serializes trivially and is easy to version, cache, and log.
- **Gives a boundary an explicit, reviewable contract** instead of leaking internal objects across it.

### Cons
<!--meta polarity=con-->

- **Duplicates fields already on the domain model**, and the mapping code is often repetitive boilerplate.
- **Two shapes to keep in sync**, so every model change risks a silent DTO mismatch.
- **Business logic or validation that creeps** into a DTO turns it into an anemic clone of the domain model.
- **Used across a call with no real boundary**, it's pure mapping ceremony with nothing to justify it.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **Data crosses a real boundary** — process, network, service, or UI tier — and the two sides shouldn't share one internal type.
- **You're crossing a boundary** drawn by a [Service Layer](./service-layer.md) and need an explicit shape for what goes in and out.
- **Return exactly what the caller needs** — one screen's data in a single call, not a partial or over-fetched domain graph.

### Avoid when
<!--meta polarity=avoid-->

- **Everything runs in one process** with one shared type — pass the domain object, as a DTO adds only a copy.
- **You need a small domain concept** with real equality and behavior, not just a shipping container — that's a [Value Object](../ddd/value-object.md).
- **The "DTO" would carry business rules or validation** — that behavior belongs on the domain side, not the transfer shape.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — an assembler mapping domain to DTO"
// Domain model — has behavior, holds internal-only fields
class User {
  constructor(
    public readonly id: string,
    private passwordHash: string,
    public email: string,
    public roles: string[],
  ) {}
  hasRole(role: string): boolean { return this.roles.includes(role); }
}

// DTO — flat, no behavior, only what the API contract promises
interface UserDTO {
  id: string;
  email: string;
  roles: string[];
}

// Assembler: the only place that knows both shapes
function toUserDTO(user: User): UserDTO {
  return { id: user.id, email: user.email, roles: user.roles };
}

// Service boundary returns the DTO, never the domain object
app.get("/users/:id", async (req, res) => {
  const user = await users.findById(req.params.id);
  res.json(toUserDTO(user)); // passwordHash never leaves the process
});
```

## In the wild
<!--meta block=wild-->

- **Protocol Buffers** — Its compiler generates flat message classes in each target language whose fields are plain accessors with no behavior; the schema is versioned independently through numbered fields, and unknown fields are preserved so old and new clients interoperate across a wire boundary. {#wild-protobuf}
- **MapStruct** — A Java annotation processor that generates the mapping code between entities and DTOs at compile time. By default it warns on a DTO field with no source and ignores an entity field the DTO lacks, unless unmappedSourcePolicy is set. {#wild-mapstruct}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Granularity** — One DTO per endpoint or one shared per entity. Per-endpoint shapes stay small and multiply; shared ones grow fields only some callers use.
- **Mapping approach** — Hand-written mappers or generated ones such as MapStruct in Java. Generated mappers cut boilerplate; hand-written ones make each field decision visible.
- **Field evolution rule** — Add optional fields, never repurpose one in place, and remove one only after no consumer reads it (signal 3). This is what lets old and new clients coexist.
- **Where validation runs** — On the DTO at the edge or on the domain type behind it. Edge validation stops bad input early; domain validation protects every entry point.

### Signals to watch
<!--meta polarity=signal-->

- **Mapper test failures after a field is added** — They catch a field that exists on one side and is missing from the other.
- **Payload size on list endpoints** — Bytes per list response at a high percentile, since a fat DTO multiplies across every row. Baseline it per endpoint, alert on growth after a release, and set the budget from your slowest client's bandwidth.
- **Fields no consumer reads** — Dead fields in a DTO that make it a leak waiting to happen.
- **Consumer contract-test failures** — Breaks that show a DTO change reached a caller.

### Failure modes under load
<!--meta polarity=failure-->

- **Entity serialized as the DTO** — The persistence object goes straight to the wire. You see internal fields exposed, lazy loads fired during serialization, or clients able to set fields they should not.
- **Mapper drift** — A field is added to the entity and left out of the mapper, so it is null or absent on the wire with no error. Catch it with a mapper test that fills every entity field and lists the ones left out on purpose.
- **DTO proliferation** — A copy per layer and a mapper per pair. You see more mapping code than logic.
- **One fat DTO for every caller** — Every endpoint returns the widest shape, so each response carries fields the caller never reads.

### Readiness checklist
<!--meta polarity=check-->

- No entity or domain type appears in a public API signature
- Mapping is covered by round-trip tests
- New fields are additive and optional
- DTOs carry data only, with no behaviour
- List-endpoint payload size has a measured budget, not just a check

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [API Design](../../themes/api-design.md) — The explicit payload contract that crosses the boundary {#fluency-api-design}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Service Layer](./service-layer.md) — Services accept and return data transfer objects (DTOs) at the boundary
- [Backend-for-Frontend](../distributed/routing/bff.md) — Each client type gets a payload shaped for its screen, not the domain
- [API Versioning](../distributed/routing/api-versioning.md) — One transfer object per published version keeps the domain model out of the wire contract
- [REPR](../architecture/repr.md) — A per-operation request and response pair is where these earn their keep
- [Interface Segregation Principle](../../principles/interface-segregation.md) — A data transfer object (DTO) is segregation applied to data: each caller sees only the fields its role uses
- [Immutability](../functional/immutability.md) — A record DTO with readonly fields set once at construction cannot drift after it is built

**Often confused with**

- [Value Object](../ddd/value-object.md) — A transfer shape with no behavior vs. a domain value

**Prevents**

- [Extraneous Fetching](../../hazards/extraneous-fetching.md) — An explicit payload shape stops a read from carrying every column the record happens to have
- [Partial Object](../../hazards/partial-object.md) — Giving each context its own carrier is what keeps one type from serving five contracts badly

**Exposed to**

- [Anemic Domain Model](../../hazards/anemic-domain-model.md) — Can fall into anemic domain model when field-only data transfer object (DTO) classes are easily reused as the domain model, and the rules then live elsewhere
- [Shotgun Surgery](../../hazards/shotgun-surgery.md) — Can fall into shotgun surgery when each transfer shape copies the same fields, so one change touches every copy
- [Primitive Obsession](../../hazards/primitive-obsession.md) — Can fall into primitive obsession when flat primitive fields carry money, ids and statuses with no validation

<!-- relationships:end -->
