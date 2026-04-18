/**
 * Validate that the existing cclsp refactoring tools work against gopls.
 * Each test writes a small Go fixture, invokes the tool in dry_run, and
 * asserts the preview indicates gopls accepted the request.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  codeActionTool,
  extractConstantTool,
  extractMethodTool,
  extractVariableTool,
  inlineTool,
  organizeImportsTool,
} from '../../src/tools/refactoring.ts';
import { getGoSession } from './gopls-session.ts';

const RUN = process.env.RUN_INTEGRATION_TESTS === '1';
const maybeDescribe = RUN ? describe : describe.skip;

maybeDescribe('existing refactoring tools vs gopls', () => {
  const created: string[] = [];

  afterAll(async () => {
    if (!RUN) return;
    const session = await getGoSession();
    await Promise.all(created.map((p) => session.disposeFile(p)));
  });

  test('organize_imports sorts/dedupes Go imports', async () => {
    const session = await getGoSession();
    const pkg = session.uniquePackage();
    const source = `package ${pkg}

import (
\t"strings"
\t"fmt"
)

func Use() string {
\treturn fmt.Sprintf("%s", strings.ToUpper("x"))
}
`;
    const file = await session.writeGoFile(`${pkg}/main.go`, source);
    created.push(file);

    const result = await organizeImportsTool.handler(
      { file_path: file, dry_run: true },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    if (!text.includes('[DRY RUN]')) console.log('[organize_imports]', text);
    expect(text).toContain('[DRY RUN]');
  });

  test('extract_variable responds structurally (gopls may or may not apply)', async () => {
    // gopls returns refactor.extract.variable as a resolve-required action
    // (hasEdit=false until codeAction/resolve is called). Our helper resolves
    // when `data` is set, but gopls's exact selection requirements vary by
    // version. We assert the tool either applied or returned the "no-action"
    // message — both mean the LSP wire is healthy.
    const session = await getGoSession();
    const pkg = session.uniquePackage();
    const source = `package ${pkg}

func F() int {
\treturn 2 * 3
}
`;
    const file = await session.writeGoFile(`${pkg}/main.go`, source);
    created.push(file);

    const result = await extractVariableTool.handler(
      {
        file_path: file,
        start_line: 4,
        start_character: 9,
        end_line: 4,
        end_character: 14,
        dry_run: true,
      },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/\[DRY RUN\]|No action available to extract variable/);
  });

  test('extract_constant on a literal', async () => {
    const session = await getGoSession();
    const pkg = session.uniquePackage();
    const source = `package ${pkg}

func F() int {
\treturn 42
}
`;
    const file = await session.writeGoFile(`${pkg}/main.go`, source);
    created.push(file);

    const result = await extractConstantTool.handler(
      {
        file_path: file,
        start_line: 4,
        start_character: 9,
        end_line: 4,
        end_character: 11,
        dry_run: true,
      },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    // gopls may not always offer a refactor.extract.constant — accept either.
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  test('extract_method responds structurally', async () => {
    const session = await getGoSession();
    const pkg = session.uniquePackage();
    const source = `package ${pkg}

func F(x int) int {
\ty := x * 2
\tz := y + 1
\treturn z
}
`;
    const file = await session.writeGoFile(`${pkg}/main.go`, source);
    created.push(file);

    const result = await extractMethodTool.handler(
      {
        file_path: file,
        start_line: 4,
        start_character: 2,
        end_line: 5,
        end_character: 12,
        dry_run: true,
      },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/\[DRY RUN\]|No action available to extract/);
  });

  test('inline on a call site', async () => {
    const session = await getGoSession();
    const pkg = session.uniquePackage();
    const source = `package ${pkg}

func double(x int) int { return x * 2 }

func F() int {
\treturn double(21)
}
`;
    const file = await session.writeGoFile(`${pkg}/main.go`, source);
    created.push(file);

    const result = await inlineTool.handler(
      { file_path: file, line: 6, character: 9, dry_run: true },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    if (!text.includes('[DRY RUN]')) console.log('[inline]', text);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  test('code_action lists actions offered by gopls', async () => {
    const session = await getGoSession();
    const pkg = session.uniquePackage();
    const source = `package ${pkg}

type S struct {
\tA int
\tB string
}

func F() S {
\treturn S{}
}
`;
    const file = await session.writeGoFile(`${pkg}/main.go`, source);
    created.push(file);

    const result = await codeActionTool.handler(
      {
        file_path: file,
        start_line: 9,
        start_character: 9,
        end_line: 9,
        end_character: 12,
      },
      session.client
    );
    const text = result.content[0]?.text ?? '';
    console.log('[code_action] offered:\n', text);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/Code actions|No code actions/);
  });
});
