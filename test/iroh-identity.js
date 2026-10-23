'use strict';

/**
 * Ключ iroh должен переживать перезапуск: иначе после рестарта мастера
 * меняется endpoint и игрокам нужен новый билет.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FILE_NAME, isKey, loadOrCreateKey } = require('../server/iroh-identity');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-iroh-key-'));
let generated = 0;
const SecretKey = {
  generate() {
    generated += 1;
    return {
      toBytes() {
        return Array.from({ length: 32 }, (_, index) => (generated + index) % 256);
      }
    };
  }
};

check('первый запуск создаёт ключ и файл', () => {
  const key = loadOrCreateKey(dir, SecretKey);
  assert(isKey(key), 'ключ неверной длины');
  assert.strictEqual(generated, 1);
  assert(fs.existsSync(path.join(dir, FILE_NAME)), 'файл ключа не создан');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'));
  assert.deepStrictEqual(stored.key, key);
});

check('повторный запуск берёт тот же ключ', () => {
  const key = loadOrCreateKey(dir, SecretKey);
  assert.strictEqual(generated, 1, 'ключ сгенерирован заново');
  assert(isKey(key));
});

check('испорченный файл заменяется рабочим ключом', () => {
  fs.writeFileSync(path.join(dir, FILE_NAME), '{ broken', 'utf8');
  const key = loadOrCreateKey(dir, SecretKey);
  assert(isKey(key));
  assert.strictEqual(generated, 2, 'после порчи файла ключ не пересоздан');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'));
  assert.deepStrictEqual(stored.key, key);
});

check('ключ неверной длины не принимается', () => {
  assert.strictEqual(isKey([1, 2, 3]), false);
  assert.strictEqual(isKey(new Array(32).fill(256)), false);
  assert.strictEqual(isKey(new Array(32).fill(0)), true);
});

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nКлюч iroh: проверок ${passed}, провалено ${failures.length}.`);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
