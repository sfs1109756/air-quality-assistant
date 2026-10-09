import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnsafeSqlError, validateSql } from './sqlGuard.js';

const blocked = (sql: string) => assert.throws(() => validateSql(sql), UnsafeSqlError, sql);

test('allows plain SELECT and CTE queries', () => {
  assert.equal(validateSql('SELECT * FROM readings;'), 'SELECT * FROM readings');
  assert.ok(validateSql('WITH x AS (SELECT 1 AS a) SELECT a FROM x'));
});

test('blocks writes, DDL and admin statements', () => {
  blocked('DELETE FROM readings');
  blocked('UPDATE readings SET co2 = 0');
  blocked('DROP TABLE devices');
  blocked("ATTACH DATABASE 'x.db' AS x");
  blocked('PRAGMA writable_schema = 1');
  blocked('WITH x AS (SELECT 1) DELETE FROM readings');
});

test('blocks multiple statements, even hidden behind comments', () => {
  blocked('SELECT 1; DROP TABLE devices');
  blocked('SELECT 1 /* ok */; DELETE FROM readings');
  blocked('SELECT 1 -- comment\n; DELETE FROM readings');
});

test('keywords inside string literals are fine', () => {
  assert.ok(validateSql("SELECT * FROM devices WHERE room = 'Update; Drop room'"));
});
