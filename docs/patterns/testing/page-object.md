---
title: Page Object
description: Wraps a UI screen's structure behind one testable interface
area: testing
owner: Oleksandr Derechei
tags: [testing, encapsulation, decoupling, maintainability]
status: stable
aliases: [POM, Page Object Model]
solves: [a designer renamed one field id and forty of my browser tests broke at once, the same login click sequence is copy-pasted into every end-to-end test we have, my ui tests are an unreadable wall of css selectors and i cannot tell what they do, every front-end refactor costs us a day of fixing tests that never changed behavior, two different test suites drive the same checkout flow and both have their own copy of it]
---

# Page Object

Wraps a UI screen's structure and interactions behind one class with a single testable interface, so tests read like user actions instead of raw locators and selectors.

## What it is
<!--meta block=description-->

A page object is a class that models one screen, or one meaningful part of it, in a user-interface test. It owns the locators and exposes intention-revealing methods such as login(email, password); tests call those methods and never touch a selector. It removes selector duplication: when a field is renamed, one page object changes and every test that goes through it is fixed. The object exposes state and actions, and the test owns the assertions.

## Explained
<!--meta block=explain-->

A page object is a class that models one screen, or one meaningful part of it, in a user-interface test. It holds the selectors, which are the strings that find each field and button, and the click sequences, and offers methods that say what the user does, such as login(email, password). The test calls those methods and does its own checking. Without it, every test that needs the login form carries its own copy of the selectors, so when a designer renames a field, every one of those tests fails for a reason unrelated to what it tests. Choose it over selectors written in each test when more than a few tests touch the same screen.

- **Extra layer.** It must be kept in step with the UI; skip it for a tiny suite.
- **Dumping ground.** One object for a whole screen bloats; split it by meaningful part.
- **Slow setup.** Driving setup through screens is slow; seed data directly.
- **Timing.** It does not fix timing; use proper waits underneath.

**Example.** A suite of 60 UI tests each types into the field with id email. A designer renames it to user-email, and all 60 tests fail. With a LoginPage object holding that selector, you make one edit and all 60 pass again. Separately, and with or without a page object, setup speed depends on how tests log in. Assume 8 seconds per UI login (illustrative): 60 times 8 is 480 seconds. Seeding the logged-in session directly, assume 0.2 seconds each, cuts setup to 12 seconds. The cost of the page object is that the team must keep it up to date for every screen change.

## How it works
<!--meta block=structure-->

```mermaid caption="The test calls a named action; the page object hides the locators and the click sequence, and hands back the object for wherever the browser lands next."
sequenceDiagram
    autonumber
    participant T as Test
    participant P as Page Object
    participant B as Browser
    T->>P: login(email, password)
    P->>B: fill fields, click submit
    alt credentials valid
        B-->>P: navigates to dashboard
        P-->>T: Dashboard page object
    else login rejected
        B--xP: error shown, no navigation
        P-->>T: Login page object with error
    end
```

## Variations
<!--meta block=variations-->

- **Component Object (Widget Object)** — One object per reusable fragment — a nav bar, a modal, a date picker — composed into whichever page objects embed it, instead of duplicating its locators on every page.
- **Fluent page objects** — Each action method returns the page object for wherever the browser ends up next, so tests read as a chain and, in a statically typed language, the compiler rejects a step that doesn't make sense from the current screen; in a dynamic one the wrong step fails at run time.
- **Page Factory / [lazy elements](../gof/extra/lazy-initialization.md)** — Locators are declared as fields and resolved on first use rather than in the constructor, so a page object can be built before its elements exist in the DOM (Document Object Model).
- **Base Page superclass** — Shared waits, navigation helpers, and common chrome (header, footer, toast messages) live in a base class that every concrete page object extends.

## Trade-offs
<!--meta block=tradeoffs-->

### Pros
<!--meta polarity=pro-->

- **Tests read as user intent** — "log in", "submit order" — not as a maze of selectors.
- **One place to fix when the UI changes**; every test using that method is fixed with it.
- **Each screen gets one stable set of methods**; the brittle page markup stays behind them.
- **Non-automation engineers can follow** and even write tests against the exposed methods.

### Cons
<!--meta polarity=con-->

- **Another layer to build** and keep in sync with the UI — overhead a tiny suite may not need.
- **A poorly scoped page object grows** into a dumping ground for every locator on the screen.
- **Methods like `login()` make UI setup the easy path**, even where a direct data seed would be faster and less flaky.
- **Doesn't fix flaky waits or timing** on its own — it still needs a solid waiting strategy underneath.

## When to use it
<!--meta block=usage-->

### Reach for it when
<!--meta polarity=when-->

- **You're automating browser or app UI tests** and the same screen is exercised by many test cases.
- **You want to isolate test logic** from DOM structure so UI refactors don't ripple through the suite.
- **Several suites** — smoke, regression, end-to-end — need to drive the same flows and should share one interaction layer.

### Avoid when
<!--meta polarity=avoid-->

- **One-off or rarely changing UI**; the wrapping overhead outweighs the benefit.
- **State can be set** up faster through an API or a data seed than by driving the UI to get there.
- **You're testing at the component or unit level**, where a lighter, in-process test harness suffices.

## Code sketch
<!--meta block=sketch-->

```typescript summary="TypeScript — a page object over a login form"
class LoginPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/login");
  }

  async login(email: string, password: string): Promise<HomePage> {
    await this.page.locator("[data-testid=email]").fill(email);
    await this.page.locator("[data-testid=password]").fill(password);
    await this.page.locator("[data-testid=submit]").click(); // click auto-waits
    return new HomePage(this.page); // caller lands on the next screen
  }
}

class HomePage {
  constructor(private readonly page: Page) {}

  welcomeBanner() {
    return this.page.locator("[data-testid=welcome-banner]");
  }
}

// Test reads as user intent, never touches a selector directly
const login = new LoginPage(page);
await login.goto();
const home = await login.login("a@b.com", "secret");
await expect(home.welcomeBanner()).toBeVisible();
```

## In the wild
<!--meta block=wild-->

- **Selenium PageFactory** — \`PageFactory.initElements(driver, page)\` populates fields annotated with \`@FindBy\` locators as lazy proxies resolved on first use; \`AjaxElementLocatorFactory\` wraps each with an implicit wait, keeping selectors in the page object rather than the test. {#wild-selenium-pagefactory}
- **Playwright** — Its official Page Object Model guide builds page classes that wrap auto-waiting \`Locator\`s behind named actions, and custom test fixtures inject those page objects into each test. {#wild-playwright}

## In production
<!--meta block=production-->

### Tuning knobs
<!--meta polarity=knob-->

- **Waiting strategy** — Auto-waiting with a configurable timeout, or explicit waits for a condition. Avoid fixed sleeps, a common cause of flake.
- **Locator strategy** — Stable test-id attributes versus CSS or XPath selectors tied to layout; the latter break when the DOM is restructured even though behavior is unchanged.
- **Retries** — How many times a failed test is automatically re-run to absorb transient flake before it is reported as a failure.
- **Parallelism** — The number of parallel browser instances or workers, which trades suite wall-clock time against resource use and cross-test isolation.

### Signals to watch
<!--meta polarity=signal-->

- **Flaky-test rate** — Tests that pass and fail without any code change — a core health metric of a UI suite.
- **Suite duration** — Wall-clock time for the UI suite; UI tests are the slowest tier and this is what caps how often they run.
- **Retry rate** — How often a test only passes on a retry — a leading indicator of flake even while the suite stays green.

### Failure modes under load
<!--meta polarity=failure-->

- **Flaky waits** — Timing assumptions that hold locally fail intermittently on a slower or loaded continuous integration (CI) runner.
- **Brittle locators** — A markup or class change breaks locators across the suite even though the user-visible behavior did not change.
- **God page object** — One object accretes every locator on the screen and becomes an unmaintainable dumping ground.
- **UI-driven setup** — Seeding state by clicking through the UI is slow and multiplies the surface for flake versus seeding via an API.

### Readiness checklist
<!--meta polarity=check-->

- Locators target stable test-ids, not CSS or XPath tied to layout.
- Waits are explicit or auto-waiting conditions, never fixed sleeps.
- Test state is seeded through an API or fixtures where possible, not driven through the UI.
- Flaky tests are quarantined and tracked, not left to pass on silent retries.

## Where it shows up
<!--meta block=fluency-->

<!-- fluency:start -->

<!-- GENERATED by gen-tours from docs/data/learning-paths.json. Do not edit this block. -->

- [Testing](../../themes/testing.md) — Wrap a screen's selectors in intention-revealing methods the tests call. {#fluency-testing}

<!-- fluency:end -->

## How it relates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Combines with**

- [Test Data Builder](./test-data-builder.md) — Build data, drive the page object
- [Arrange-Act-Assert](./arrange-act-assert.md) — Its methods keep the Act step one line

**Specializes**

- [Facade](../gof/structural/facade.md) — A facade over one screen's selectors and waits

<!-- relationships:end -->
