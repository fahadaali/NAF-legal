// عُدّة الفحوص المشتركة: قاعدةٌ بواجهة D1 فوق node:sqlite بهجرات المستودع كلِّها،
// وتحزيمُ شيفرة `src/` كما هي لتُشغَّل في Node.
//
// `legal-contract-check.mjs` بنى نسخته من هذا قبلها ولم يُنقل إليها: نقلُه تغييرٌ
// في فحصٍ يمرّ اليوم لا يزيد ما يفحصه شيئاً. والفحوص الجديدة تستعمل هذه.
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * قاعدةٌ جديدة في الذاكرة بالهجرات كلِّها، وبديلُ D1 فوقها.
 *
 * `bind` يُعيد نسخةً لا يعدّل الأصل، كما في D1: الاستعلام المجهَّز يُعاد ربطه.
 */
export async function makeDb() {
  const files = (await readdir(path.join(ROOT, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
  const sqlite = new DatabaseSync(':memory:');
  for (const f of files) sqlite.exec(await readFile(path.join(ROOT, 'migrations', f), 'utf8'));

  class Prepared {
    constructor(sql, args = []) {
      this.sql = sql;
      this.args = args;
    }
    bind(...args) {
      return new Prepared(this.sql, args);
    }
    async all() {
      return { results: sqlite.prepare(this.sql).all(...this.args), success: true };
    }
    async first(col) {
      const row = sqlite.prepare(this.sql).all(...this.args)[0] ?? null;
      return col && row ? row[col] : row;
    }
    async run() {
      const r = sqlite.prepare(this.sql).run(...this.args);
      return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
    }
  }

  const DB = {
    prepare: (sql) => new Prepared(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { sqlite, DB, q: (sql, ...args) => sqlite.prepare(sql).all(...args) };
}

/** بديل KV في الذاكرة — بالقدر الذي تستعمله المنصة: get/put/delete مع expirationTtl. */
export function makeKv() {
  const m = new Map();
  return {
    async get(k, type) {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) {
      m.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    },
    async delete(k) {
      m.delete(k);
    },
    _map: m,
  };
}

/**
 * يحزّم مدخلاً من `src/` ويستورده.
 *
 * `stubs` يستبدل وحداتٍ بأسمائها كما تُستورد (`'../lib/auth'`) بنصٍّ يُعطى —
 * لتُفحص المسارات دون مركز الهوية، أو دون نداء Claude.
 */
export async function bundle(name, contents, { resolveDir = path.join(ROOT, 'src', 'lib'), stubs = {} } = {}) {
  const esbuild = await import('esbuild');
  const cache = path.join(ROOT, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  const stubPlugin = {
    name: 'stubs',
    setup(build) {
      const keys = Object.keys(stubs);
      if (!keys.length) return;
      const filter = new RegExp(`^(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`);
      build.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'ts' }));
    },
  };
  const built = await esbuild.build({
    stdin: { contents, resolveDir, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    plugins: [stubPlugin],
    logLevel: 'silent',
  });
  const out = path.join(cache, `naf-${name}.mjs`);
  await writeFile(out, built.outputFiles[0].text);
  return import(pathToFileURL(out).href + `?t=${Date.now()}`);
}

/** عدّادٌ للفحوص ومُبلِّغٌ بنتيجتها — بصيغة فحوص المستودع. */
export function suite(title) {
  let passed = 0;
  const failed = [];
  return {
    async check(name, fn) {
      try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
      } catch (e) {
        failed.push(name);
        console.log(`  ✗ ${name}\n      ${String(e?.message ?? e).split('\n').join('\n      ')}`);
      }
    },
    done() {
      console.log(`\n${title}: ${passed} نجحت · ${failed.length} أخفقت`);
      if (failed.length) process.exit(1);
    },
  };
}
