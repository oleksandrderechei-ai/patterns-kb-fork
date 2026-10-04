---
title: Connect Four
description: "Drop discs into a 7×6 grid and detect four in a row — an object-oriented design about where the game rules, the grid math, and the game's state each belong"
area: designs-foundational
owner: Oleksandr Derechei
tags: [low-level-design, separation-of-concerns, encapsulation, state-management]
status: stable
aliases: []
solves: [I have three boolean status flags and half their combinations are impossible states I keep having to guard against, adding another win direction means editing four nearly identical checker classes that differ by two numbers, "one class knows the grid math, the turn rules and the win detection all at once", I want to bolt on a computer opponent without rewriting the rules of the game, I cannot decide whether win detection belongs on the game controller or on the board]
---

# Connect Four

Two players alternate dropping discs into a seven-column, six-row grid; a disc falls to the lowest free cell, and the first to line up four of one colour — vertical, horizontal, or diagonal — wins, or a full board draws. As a low-level design it is almost entirely about responsibility: which object enforces the turn, which owns the grid and its win geometry, and how to model the game's state so an impossible combination cannot be written down.

## Understanding the problem
<!--meta block=description-->

On a turn the current player names a column and the disc drops to the lowest empty row. The game ends when someone connects four in a line, or in a draw when the board fills. There is no scale story: one game, two players, a 42-cell board, backend only. The page is object modelling: the right classes, and rejecting illegal moves without corrupting state.

## Explained
<!--meta block=explain-->

A Connect Four model splits the rules by what they depend on: a game object enforces turns and the game's state, a board object owns the grid and checks for four in a row, and a player is just a name and a colour. Choose this split when the rules are fixed and the risk is an illegal move, not speed; a game whose win shapes vary would justify one checker class per direction, and this one does not. Game state is one value, in progress, won or drawn, because three separate true-or-false flags allow 8 combinations when only 3 are legal.

- **Winner beside state.** A winner stored beside the state still allows won-with-no-winner, so check that pair in the one method that changes state.
- **Opaque rejection.** A shared -1 cannot say which rule broke, so return a small result type once callers must react per reason.
- **Rescanning.** Rescanning on every move costs nothing on 42 cells; add a per-column height index only when the board grows.

**Example.** Yellow drops into column 3, which already holds 6 discs. The board answers -1, the game leaves every cell and the turn untouched, and Yellow tries again. Later Red drops into column 4 and the disc lands in row 2. The board counts matching discs from that cell along 4 directions, each way, using one helper that takes a step like (1,1); it finds 4 on a diagonal, and the game sets its state to won and records Red.

## Requirements
<!--meta block=requirements-->

### Functional
<!--meta requirement=fr-->

1. Two players alternate dropping discs into a fixed 7-column, 6-row board; a disc lands in the lowest free row of the chosen column.
2. Detect a win the moment a player connects four discs in a line — vertical, horizontal, or either diagonal.
3. Declare a draw when the board fills with no winner.
4. Reject every invalid move clearly — a full column, a move out of turn, or any move after the game has ended — without mutating state.

Out of scope: UI and rendering, concurrent games, move history and undo, and configurable board size. The core is turn enforcement, disc placement, and win detection.

### Non-functional (constraints)
<!--meta requirement=nfr-->

- **Legal states only** — the model should make "won and drawn at once" or "over but no winner" impossible to write down.
- **Encapsulation** — grid rules live behind the board; a caller drives the whole game through one small public surface.
- **Fail closed** — an illegal move returns a clear rejection and leaves the board untouched.
- **Evolvability** — a bot opponent, a different board size, or undo should slot in without rewriting the core.

## Core entities
<!--meta block=entities-->

Three classes and two enums — and a deliberate refusal to add more:

- **Game** — the orchestrator and public entry point. Holds the two players, whose turn it is, the board, and the game's state. On a move it validates turn and state, delegates the physical placement to the board, asks the board whether that placement won, and advances the turn.
- **Board** — the 7×6 grid and every rule about it: whether a column has room, where a dropped disc lands, whether the board is full, and whether a given placement completed four in a row. It knows nothing about turns or whose game it is.
- **Player** — a pure data holder: a name for identity and a disc colour. No game logic lives here, on purpose.
- **GameState / DiscColor** — two small enums. `GameState` is `IN_PROGRESS | WON | DRAW`; `DiscColor` is `RED | YELLOW`. The board stores colours rather than players, so it stays testable without mocking a Player.

## The interface
<!--meta block=interface-->

Game is the only object a caller touches, and `makeMove` is its single state-mutating method — everything else is read-only. Board exposes just enough for Game to drive it and returns a `-1` sentinel rather than throwing, so Game's happy path stays a straight line:

```python summary="Pseudocode — the public surfaces"
class Game:
    makeMove(player, column) -> bool     # validate, place, check win/draw, switch turn
    getCurrentPlayer()       -> Player
    getGameState()           -> GameState
    getWinner()              -> Player?   # null until someone wins
    getBoard()               -> Board

class Board:
    canPlace(column)              -> bool
    placeDisc(column, color)      -> int         # returns the landing row, or -1 if illegal
    checkWin(row, column, color)  -> bool
    isFull()                      -> bool
    getCell(row, column)          -> DiscColor?
```

## How the system is built
<!--meta block=architecture-->

Game owns a Board and two Players and holds the state enum plus a nullable winner. `makeMove` is the one choke point: it rejects the move if the game is already over or it is the wrong player's turn, then calls `placeDisc`, which returns the landing row or `-1`. On a valid landing Game asks `checkWin` at that cell — a win sets `state = WON` and records the winner, a full board sets `DRAW`, otherwise the turn switches. The board owns all grid math; Game only reads the board's answers and updates its own state from them.

~~~mermaid caption="Game orchestrates; Board owns the grid and its win geometry; Player is pure data. The board's cells hold a DiscColor, not a Player, so it stays testable in isolation. `winner` is null until someone wins."
classDiagram
    class Game {
        -Board board
        -Player player1
        -Player player2
        -Player currentPlayer
        -GameState state
        -Player winner
        +makeMove(player, column) bool
        +getCurrentPlayer() Player
        +getGameState() GameState
        +getWinner() Player
    }
    class Board {
        -int rows
        -int cols
        -List~List~DiscColor~~ grid
        +placeDisc(column, color) int
        +checkWin(row, column, color) bool
        +isFull() bool
        +canPlace(column) bool
    }
    class Player {
        -String name
        -DiscColor color
        +getName() String
        +getColor() DiscColor
    }
    class GameState {
        <<enumeration>>
        IN_PROGRESS
        WON
        DRAW
    }
    class DiscColor {
        <<enumeration>>
        RED
        YELLOW
    }
    Game "1" o-- "1" Board : owns
    Game "1" o-- "2" Player : tracks
    Game ..> GameState : holds
    Board ..> DiscColor : stores
    Player ..> DiscColor : has
~~~

## Deep dives
<!--meta block=deepdives-->

### 1 · Modelling game state — an enum, not a bag of booleans

The state a Game must expose is exactly one of three values: in progress, won, or drawn. The tempting first cut is three boolean flags — `isOver`, `hasWinner`, `isDraw` — beside a nullable `winner`.

- **Three booleans, eight worlds.** Three flags encode 2³ = 8 combinations for a domain that has 3 legal states. `isOver=false, hasWinner=true` (won but not over?) and `isOver=true, isDraw=true, hasWinner=true` (a win and a draw?) are both writable, and each one has to be kept consistent by hand on every move. The type system is now working against you.
- **One enum, three states (chosen).** A single `GameState` collapses those eight ghosts to three real states; the field holds exactly one, and "won and drawn at once" simply cannot be expressed. Adding `PAUSED` or `ABANDONED` later is one new enum value, not another boolean and a fresh round of coordination logic everywhere. This is the design leaning on [Keep It Simple, Stupid (KISS)](../principles/kiss.md) and, more sharply, on [making illegal states unrepresentable](../principles/make-illegal-states-unrepresentable.md).
- **The honest gap.** `winner` is still a separate nullable field, so `state=WON` with `winner=null` remains technically writable. Languages with tagged unions — Rust, Swift, Kotlin sealed classes, TypeScript discriminated unions — can fold the winner into the `WON` case and close it; Java, Python, C#, and Go cannot do it cleanly, so a plain enum plus a nullable winner is the pragmatic call. Naming the ideal shows depth without over-building the real thing.

### 2 · One win-check, four directions — not four checkers

Win detection is where the design most invites over-engineering. From the cell just played, the board must look for four in a row along four axes: horizontal, vertical, and the two diagonals.

- **Four checker classes.** The over-built answer is a `WinChecker` interface with a `HorizontalWinChecker`, a `VerticalWinChecker`, and two diagonal classes, looped over inside `checkWin` — a [Strategy](../patterns/gof/behavioral/strategy.md) arrangement. But all four bodies are the identical "count contiguous discs both ways"; only a pair of step values differs. That is parameterisable data masquerading as polymorphism, and Connect Four's win geometry is fixed forever, so the extension point guards a requirement that will never change — a textbook [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) violation and a misapplied Strategy.
- **Directions as data (chosen).** The unified version treats the four axes as vectors — `(0,1)`, `(1,0)`, `(1,1)`, `(-1,1)` — and reuses one `countInDirection(row, col, dr, dc, color)` helper for each vector and its opposite. Four lines of loop replace four classes. A fix to the counting logic lands once instead of four times, and extending to "five in a row" or a larger board is a one-method change. This is [Don't Repeat Yourself (DRY)](../principles/dry.md) doing real work: one behaviour, expressed once, driven by different parameters.

```mermaid caption="How does one helper cover four axes? Each vector is counted forward and backward from the cell just played, and four or more in a row on any axis wins."
flowchart TB
    Start(["checkWin(row, column, color)"]) --> Pick["Take the next vector (dr, dc)"]
    Pick --> Fwd["countInDirection(row, col, dr, dc, color)"]
    Pick --> Back["countInDirection(row, col, -dr, -dc, color)"]
    Fwd --> Sum{"forward + backward + 1 >= 4?"}
    Back --> Sum
    Sum -->|"yes"| Win(["return true"])
    Sum -->|"no, vectors left"| Pick
    Sum -->|"no, none left"| None(["return false"])
```

### 3 · Which object owns which rule

The three classes only earn their keep if every rule has an obvious home.

- **Board owns grid rules.** Bounds checking, the lowest-free-row scan, the full-board test, and win detection all live on Board, because they depend only on the grid — not on turns or players. `placeDisc` does its own validation and returns `-1` for an illegal column rather than making Game pre-check with `canPlace`, so grid validation stays in one place.
- **Game owns game rules.** Turn order, the state transitions, and rejecting a move out of turn or after the end live on Game. `makeMove` is the single mutating method and validates in a fixed order — game not over, then correct player, then a legal landing — before anything changes. This split is [separation of concerns](../principles/separation-of-concerns.md) and the [single-responsibility principle](../principles/single-responsibility.md) made concrete: two reasons to change — grid geometry versus game flow — live in two classes.
- **Player owns nothing but data.** A name and a colour, two getters, no logic — deliberately a [value object](../patterns/ddd/value-object.md), so identity and decision-making stay separate. Making Player an interface with Human and Bot subclasses would add abstraction a pure data holder cannot justify (a human "does" nothing), which is exactly why the bot opponent below is a separate collaborator instead.

The fixed validation order matters because each check is cheaper and safer than the next. A move after the game ends or out of turn is rejected before the board is touched, so a rejected call leaves no half-applied state to undo.

```mermaid caption="In what order does makeMove decide? Two cheap guards on Game run first, the board is touched only after both pass, and the state changes only after the board reports its answer."
sequenceDiagram
    participant C as Caller
    participant G as Game
    participant B as Board
    C->>G: makeMove(player, column)
    alt game is not IN_PROGRESS or wrong player
        G-->>C: false
    else guards pass
        G->>B: placeDisc(column, color)
        B-->>G: landing row, or -1
        alt row is -1
            G-->>C: false
        else disc landed
            G->>B: checkWin(row, column, color)
            B-->>G: win or no win
            G->>G: set WON, or DRAW if board is full, else switch turn
            G-->>C: true
        end
    end
```

### 4 · Extending without a rewrite

Because the rules sit behind `makeMove` and the grid math behind Board, each common follow-up touches a small, predictable place — the design is [open for extension](../principles/open-closed.md) without modifying the core.

- **Board size.** `rows` and `cols` are already the only dimensions the placement and win logic reference; promote them to constructor parameters and an arbitrary board just works.
- **Undo.** Every move flows through `makeMove`, so a `moveHistory` stack of small `Move` value objects — `(player, row, col)` — lives naturally on Game; undo pops one, clears that cell on Board, and rewinds the turn. It reads like a lightweight [command](../patterns/gof/behavioral/command.md) history and needs no change to how a move is made.
- **A computer opponent.** The rules do not move at all: a `BotEngine` inspects the board and returns a column, and Game sees an ordinary `makeMove(currentPlayer, column)`. Choosing a separate collaborator over a `BotPlayer` subclass keeps Player pure and favours [composition over inheritance](../principles/composition-over-inheritance.md) — the bot is a decision layer bolted beside the game, not woven into it.

~~~mermaid caption="What states can a game hold, and how does each end? The three real values of `GameState` — the eight boolean worlds collapse to these, and \"won and drawn at once\" has no state to occupy."
stateDiagram-v2
    [*] --> InProgress
    InProgress --> InProgress: valid move, game continues
    InProgress --> Won: move completes four in a row
    InProgress --> Draw: move fills the last cell
    Won --> [*]
    Draw --> [*]
~~~

## Limitations & trade-offs
<!--meta block=tradeoffs-->

### What it buys
<!--meta polarity=pro-->

- One state enum makes the impossible combinations of three boolean flags unwritable — the type holds exactly one of three real states.
- Grid rules on Board, game rules on Game, nothing on Player — each reason to change lives in exactly one class, each testable alone.
- One direction-vector loop replaces four checker classes, so a win-logic fix or a rule variant is a single edit.

### What it gives up
<!--meta polarity=con-->

- The enum closes all five illegal boolean combinations, but not every bad state: `state=WON` with a null winner lives on the separate winner field and stays representable in languages without tagged unions.
- `placeDisc` signals every illegal move with the same `-1` sentinel, so a full column and an out-of-bounds column are indistinguishable and callers must remember to check.
- `checkWin` rescans from the placed cell and `placeDisc` rescans the column each move — trivial for forty-two cells, but a `heights[]` index would be needed if the board grew large.

## What's expected at each level
<!--meta block=levels-->

- **Junior** — decomposes into a board, players, and an orchestrator with roughly sensible responsibilities; `placeDisc` finds the lowest empty row; horizontal and vertical win checks are correct (diagonals may need a hint); a plain `return false` for a bad move is fine. Bar: a complete game that ends in a correct win or draw.
- **Mid-level** — clean separation without prompting (Game orchestrates, Board owns the grid and win detection, Player is data), `makeMove` validates state → turn → column in that order before mutating, win-checking uses the direction-vector form rather than four methods, and can place one extension (undo or board size) without coding it.
- **Senior** — boundaries read as production-reviewable and are justified aloud: why Player is pure data, why `GameState` is an enum over booleans, why win detection sits on Board. Catches edge cases unprompted, uses the single `countInDirection` helper, and weighs multiple extensions with trade-offs (a bot leaves the rules untouched and adds only a decision layer). Finishing early enough to discuss networked or spectator variants is a strong signal.

## Patterns it demonstrates
<!--meta block=relationships-->

<!-- relationships:start -->

<!-- GENERATED by gen-relations from docs/data/relations.json. Do not edit this block. -->

**Demonstrates**

- [Separation of Concerns](../principles/separation-of-concerns.md) — Grid geometry lives on Board, turn and state rules on Game, so the two reasons to change never mix
- [Single Responsibility Principle](../principles/single-responsibility.md) — Each class carries one job — Board the grid, Game the flow, Player the data — and one reason to change
- [Don't Repeat Yourself (DRY)](../principles/dry.md) — Four win directions collapse to one countInDirection helper driven by (dr,dc) vectors, so a fix lands once not four times
- [You Aren't Gonna Need It (YAGNI)](../principles/yagni.md) — A per-direction WinChecker Strategy is refused because Connect Four's win geometry is fixed forever
- [Keep It Simple (KISS)](../principles/kiss.md) — A three-value GameState enum replaces three coupled booleans, killing the impossible combinations
- [Value Object](../patterns/ddd/value-object.md) — Player is a name-and-colour data holder with no logic, and Move records (player,row,col) for undo
- [Composition over Inheritance](../principles/composition-over-inheritance.md) — A computer opponent is a separate BotEngine collaborator, not a BotPlayer subclass, keeping Player pure
- [Open/Closed Principle](../principles/open-closed.md) — Board size, undo, and a bot opponent each slot in behind makeMove and Board without editing the core rules
- [Strategy](../patterns/gof/behavioral/strategy.md) — Refuses a WinChecker Strategy for win detection: the four directions differ only in step values, so one helper driven by vectors replaces four classes

<!-- relationships:end -->
