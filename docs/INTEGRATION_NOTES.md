# Integration test notes

Tracking known gaps between what cclsp's tools can drive and what each
language server surfaces under our integration harness's minimal workspace.

## Harnesses

There are two parallel harnesses, both in `test/integration/`:

- `session.ts` — **jdtls** (Java). Spawns jdtls against a bare
  `/tmp/cclsp-integration-<pid>-<timestamp>/` directory with no build-tool
  configuration. jdtls calls this an "invisible project" — every `.java`
  file is a standalone source with the default JDK classpath.
- `gopls-session.ts` — **gopls** (Go). Spawns gopls against a fresh directory
  after running `go mod init cclsp.test`. gopls needs a `go.mod` to offer
  most refactorings; the harness creates one automatically.

Both harnesses follow the same singleton pattern: one server process per
`bun test` run, shared across all integration test files.

## jdtls harness — tools that require a richer project

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

## gopls harness — coverage

gopls is much cheaper to drive than jdtls (single binary, sub-second
startup, no JVM) and uses fine-grained `refactor.*` kinds for every
refactoring, so our generic tools work without the bare-kind title-matching
trick we needed for jdtls.

### Cross-server tools validated against gopls

- `organize_imports` — gopls `source.organizeImports` (dry_run preview)
- `extract_variable`, `extract_constant`, `extract_method` — structural
  check; gopls requires the cursor to land on a valid expression
- `inline` — same structural guarantee
- `code_action` — lists gopls's offerings (source.addTest, source.assembly,
  source.doc, source.splitPackage, refactor.extract.*, refactor.rewrite.*,
  gopls.doc.features)

### Go-specific tools

- `fill_struct` — `refactor.rewrite.fillStruct`, with full round-trip
  coverage (writes struct fields to disk)
- `fill_switch` — `refactor.rewrite.fillSwitch` (unit-tested)
- `change_quote`, `join_lines`, `split_lines` — position-based rewrites
- `eliminate_dot_import`, `remove_unused_param` — `refactor.rewrite.*`
- `move_param` (left/right) — routes to `moveParamLeft` / `moveParamRight`
- `move_to_new_file` — `refactor.extract.toNewFile`

### gopls notes

- gopls uses codeAction resolution: actions arrive with `hasEdit=false` /
  `hasCommand=false` and the edit is filled in via `codeAction/resolve`.
  Our helper always attempts resolve now (see
  `src/lsp/operations.ts:resolveCodeAction`) so this works transparently.
- `rename_file` was not added as a dedicated tool. gopls surfaces file
  renames via file-system watchers rather than a code action; use
  `execute_command` with the relevant gopls command ID if needed.

## Working integration tests

- `organize-imports.integration.test.ts` — jdtls round-trip
- `generators.integration.test.ts` — jdtls `generate_getters_setters`
- `refactor-selection.integration.test.ts` — jdtls `extract_variable`,
  `convert_for_loop`, `invert_boolean_or_condition`
- `generic-tools.integration.test.ts` — jdtls `code_action` + `execute_command`
- `gopls-validation.integration.test.ts` — cross-server tools vs gopls
- `gopls-tools.integration.test.ts` — Go-specific refactorings (incl.
  `fill_struct` apply path)

## Future work

- **jdtls**: second harness variant that writes a `pom.xml` / `.project`
  pair so jdtls enters full-project mode, unblocking the generator and
  quickfix tools that currently don't surface.
- **gopls**: exercise the quickfix-from-diagnostic path (add missing
  import, add missing function, etc.) by seeding fixtures with broken
  references.
- Shared: refactor the two session files to share more common code
  (jdtls/gopls differ mostly in binary resolution and workspace bootstrap).
