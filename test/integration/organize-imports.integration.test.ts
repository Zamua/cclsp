import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { organizeImportsTool } from '../../src/tools/refactoring.ts';
import { getSession } from './session.ts';

const RUN = process.env.RUN_INTEGRATION_TESTS === '1';
const maybeDescribe = RUN ? describe : describe.skip;

maybeDescribe('organize_imports (jdtls integration)', () => {
  const created: string[] = [];

  afterAll(async () => {
    if (!RUN) return;
    const session = await getSession();
    await Promise.all(created.map((p) => session.disposeFile(p)));
  });

  test('removes unused imports and alphabetizes the rest', async () => {
    const session = await getSession();
    const pkg = session.uniquePackage();
    const pkgPath = pkg.replace(/\./g, '/');
    const className = 'Messy';

    const source = `package ${pkg};

import java.util.Map;
import java.util.ArrayList;
import java.io.IOException;
import java.util.List;
import java.util.HashMap;

public class ${className} {
    public static void main(String[] args) {
        List<String> items = new ArrayList<>();
        items.add("hello");
        Map<String, Integer> counts = new HashMap<>();
        counts.put("hello", items.size());
        System.out.println(counts);
    }
}
`;

    const file = await session.writeJavaFile(`src/${pkgPath}/${className}.java`, source);
    created.push(file);

    const result = await organizeImportsTool.handler(
      { file_path: file, dry_run: false },
      session.client
    );
    // Helper wraps the result as 'Applied "<action title>" to <file>'.
    expect(result.content[0]?.text).toContain('Applied');
    expect(result.content[0]?.text?.toLowerCase()).toContain('organize imports');

    const after = readFileSync(file, 'utf-8');
    expect(after).not.toContain('java.io.IOException');
    // Alphabetical order: ArrayList < HashMap < List < Map
    const idxArrayList = after.indexOf('java.util.ArrayList');
    const idxHashMap = after.indexOf('java.util.HashMap');
    const idxList = after.indexOf('java.util.List');
    const idxMap = after.indexOf('java.util.Map');
    expect(idxArrayList).toBeGreaterThan(-1);
    expect(idxArrayList).toBeLessThan(idxHashMap);
    expect(idxHashMap).toBeLessThan(idxList);
    expect(idxList).toBeLessThan(idxMap);
  });

  test('dry_run previews without touching disk', async () => {
    const session = await getSession();
    const pkg = session.uniquePackage();
    const pkgPath = pkg.replace(/\./g, '/');

    const source = `package ${pkg};

import java.util.Map;
import java.io.IOException;
import java.util.List;

public class DryRunExample {
    List<Map<String, Object>> data;
}
`;
    const file = await session.writeJavaFile(`src/${pkgPath}/DryRunExample.java`, source);
    created.push(file);

    const result = await organizeImportsTool.handler(
      { file_path: file, dry_run: true },
      session.client
    );
    expect(result.content[0]?.text).toContain('[DRY RUN]');

    const after = readFileSync(file, 'utf-8');
    expect(after).toBe(source);
  });
});
