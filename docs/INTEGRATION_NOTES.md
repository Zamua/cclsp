# Integration test notes

Tracking known gaps between what cclsp's tools can drive and what jdtls
surfaces under our integration harness's minimal workspace.

## Harness context

The harness in `test/integration/session.ts` spawns jdtls against a fresh
`/tmp/cclsp-integration-<pid>-<timestamp>/` directory with **no build-tool
configuration** (no `pom.xml`, no `build.gradle`, no `.project`). jdtls calls
this an "invisible project" — every `.java` file is a standalone source with
the default JDK classpath. That's enough to prove the LSP wire, but some
code actions that jdtls normally offers in an IDE require a richer project.

## Tools with mock unit-test coverage but no reliable integration path yet

Each of these is implemented and covered by mock-based unit tests in
`src/refactoring-actions.test.ts`. The behaviour has been verified at the
helper level; what's missing is a jdtls scenario where the action fires.

### Group A — file-scope generators

| Tool | Why it doesn't surface on invisible-project |
| --- | --- |
| `generate_tostring` | jdtls only advertises `source.generate.toString` once there's at least one field AND the class passes its "has methods to be generated" heuristic. Surfaces intermittently in our harness; needs a maven/gradle project to be reliable. |
| `generate_hashcode_equals` | Needs `equals(Object)`/`hashCode()` not already present and a resolvable project scope to pick hashing strategy. |
| `generate_constructors` | Only offered when at least one field exists AND no matching constructor is already defined. In our harness it did not surface even with fields — possibly needs the class to be part of a classpath-resolved project. |
| `generate_delegate_methods` | Requires a field whose type resolves to a class with methods to delegate. Needs a real classpath. |
| `override_methods` | Requires the class to extend/implement something whose members are resolvable. Despite extending `AbstractList` (stdlib), jdtls returned no action — likely because the "invisible project" classpath lookup for java.util isn't fully wired. |

Workaround for users: run cclsp against a real Maven/Gradle project and the
tools will fire as expected.

### Group B — quickfixes

All quickfix tools (`add_missing_imports`, `add_missing_method`, etc.) are
gated on a matching diagnostic being present on the file. In the invisible
project, diagnostics for unresolved symbols aren't emitted, so the quickfix
code-actions have nothing to attach to. These should all work against a
real project; the LSP plumbing is identical to what unit tests exercise.

### Group C/D — extract/rewrite refactorings

Most of these (`extract_variable`, `convert_for_loop`,
`invert_boolean_or_condition`) rely only on the cursor being on a valid
expression/statement and should surface even on the invisible project.
They have integration coverage in `refactor-selection.integration.test.ts`.

### Group E — cross-file moves

`move_member`, `extract_interface`, `extract_superclass` generally require a
configured project with classpath resolution. They are not covered by
integration tests in the invisible-project harness.

## Working integration tests

- `organize-imports.integration.test.ts` — full round-trip, removes unused
  imports + alphabetizes.
- `generators.integration.test.ts` — `generate_getters_setters` only.
- `refactor-selection.integration.test.ts` — `extract_variable`,
  `convert_for_loop`, `invert_boolean_or_condition`.

## Future work

- Build a second harness variant that writes a `pom.xml` (or
  `.classpath`/`.project` pair) so jdtls enters full-project mode. That
  should unblock every generator and quickfix tool above.
- Consider a marker file the harness can drop (`.project` pointing at
  `org.eclipse.jdt.core.javanature`) to get richer jdtls behaviour without
  pulling in a full Maven build.
