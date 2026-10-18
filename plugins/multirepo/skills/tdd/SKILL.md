---
name: tdd
description: Red/green/refactor test-driven development discipline for agents writing production code. Use whenever implementing a feature, a business rule, a validation, a calculation or a bug fix in any language: write one failing test, prove it fails for the right reason, write the minimum code to pass, run the suite, refactor. Bug fixes start with a test that reproduces the bug. Applies to implementation subagents and to any coding step of an implement run.
user-invocable: false
---

# Red / Green / Refactor

How to write production code test-first. Agents implementing features or fixes follow this; it's not a command for users.

## When

- New or changed behaviour: business logic, handlers, endpoints, validations, calculations, state transitions.
- **Bug fixes: always.** The first step is a test that reproduces the bug.
- Not for: pure config, generated code, copy changes, or a spike that will be thrown away (say so when skipping).

## Find the test setup first

Use what the repo already uses. Look, in order, at the repo's `CLAUDE.md` / `AGENTS.md`, its `README` / `CONTRIBUTING`, the test scripts in its manifest (`package.json` scripts, `Makefile`, `pyproject.toml`, `*.csproj` test projects, `Cargo.toml`, `go.mod`), and existing tests near the code you're changing: their location, naming, fixtures and mocking style. Copy those conventions. Don't add a new framework or assertion library.

Running a single test (hints; the repo's own command wins):

| Runner | One test by name |
|---|---|
| node:test | `node --test --test-name-pattern "<name>" <file>` |
| Vitest | `npx vitest run <file> -t "<name>"` |
| Jest | `npx jest <file> -t "<name>"` |
| pytest | `pytest <file> -k "<name>"` |
| Go | `go test ./<pkg> -run '^<TestName>$'` |
| .NET | `dotnet test --filter "FullyQualifiedName~<Class>.<Method>"` |
| Cargo | `cargo test <name>` |
| RSpec | `rspec <file> -e "<description>"` |

## The cycle

### 1. Red: one failing test

1. Pick **one** behaviour, small enough to state as a single assertion.
2. Write one focused test for it, named like a sentence (`rejects a negative amount`, `Validate_ZeroAmount_ReturnsError`, whatever the repo uses).
3. **Run only that test** with a filter, and read the failure. It must fail *for the right reason*: the assertion fails, or the function doesn't exist yet. A syntax error, a missing import or a broken fixture isn't red; fix it and run again.
4. If it passes already, it isn't testing new behaviour: change the test, or you've learned the behaviour exists.

### 2. Green: the minimum to pass

1. Write only enough production code to make that test pass. No extra branches, options or edge cases the test doesn't demand.
2. Run the test: it passes.
3. **Run the whole suite** (or the affected project's): nothing else broke. If something did, fix it before going on.

### 3. Refactor: tidy without new behaviour

1. Remove duplication that's really there, improve names, simplify.
2. Run the suite again: still green.
3. No new behaviour here. New behaviour means a new red.

Then the next behaviour, its own cycle. Keep cycles small and fast.

## Bug fixes

1. **Red**: a test that reproduces the reported misbehaviour, failing the way the bug report describes.
2. **Green**: the smallest fix that makes it pass.
3. **Refactor**, suite green.

The test stays: it proves the fix and guards against the regression.

## Writing the tests

- **One behaviour per test**, arrange / act / assert, no conditionals or loops in the test.
- **Only the data the assertion needs**; simple, obvious values.
- **Mock only direct dependencies**, never the thing under test. Prefer asserting resulting state over asserting calls.
- **Deterministic**: no real clock, randomness, network or shared state unless the repo's tests already control them.

## Rules

- **Never batch the tests at the end.** Each piece of behaviour gets its test before its code.
- **Show the evidence.** Report the red run (the failure line) and the green suite run for each cycle, briefly; "tests pass" without a run isn't evidence.
- **Never weaken a test to get green** (loosening assertions, skipping, deleting). If the test was wrong, say why and fix it deliberately.
- **No test setup in the repo?** Don't bootstrap a framework on your own; report it and ask (or follow what the calling skill says).
