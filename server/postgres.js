import { Pool } from 'pg';

// A fixed, application-specific key shared by every NEBO replica. PostgreSQL
// releases this lock automatically when the initialization transaction ends.
const INITIALIZATION_LOCK = [0x4e45424f, 1];

// Auth SQL uses D1's anonymous parameters. Keep quoted text and comments intact
// while translating placeholders; values always travel separately to pg.
function compileSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL must be a nonempty string');
  let text = '';
  let parameters = 0;
  let index = 0;
  while (index < sql.length) {
    const start = index;
    const character = sql[index];
    if (character === "'" || character === '"') {
      const escaped = character === "'" && /[eE]/.test(sql[index - 1] || '') && !/[\w$]/.test(sql[index - 2] || '');
      index++;
      while (index < sql.length) {
        if (escaped && sql[index] === '\\') { index += 2; continue; }
        if (sql[index++] === character) {
          if (sql[index] !== character) break;
          index++;
        }
      }
    } else if (sql.startsWith('--', index)) {
      index = sql.indexOf('\n', index + 2);
      if (index === -1) index = sql.length;
    } else if (sql.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth) {
        if (sql.startsWith('/*', index)) { depth++; index += 2; }
        else if (sql.startsWith('*/', index)) { depth--; index += 2; }
        else index++;
      }
    } else if (character === '$' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(index))) {
      const delimiter = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)[0];
      const end = sql.indexOf(delimiter, index + delimiter.length);
      index = end === -1 ? sql.length : end + delimiter.length;
    } else if (character === '?') {
      text += '$' + ++parameters;
      index++;
      continue;
    } else index++;
    text += sql.slice(start, index);
  }
  return { text, parameters };
}

class PgStatement {
  constructor(database, compiled, values = []) {
    this.database = database;
    this.compiled = compiled;
    this.values = values;
  }

  bind(...values) {
    return new PgStatement(this.database, this.compiled, values);
  }

  async first(column) {
    const result = await this.database._execute(this);
    const row = result.results[0];
    if (!row) return null;
    return column === undefined ? row : row[column];
  }

  all() { return this.database._execute(this); }
  run() { return this.database._execute(this); }
}

export class PgDatabase {
  constructor(pool, client = null) {
    this.pool = pool;
    this.client = client;
  }

  prepare(sql) { return new PgStatement(this, compileSql(sql)); }

  async _execute(statement) {
    if (statement.values.length !== statement.compiled.parameters) {
      throw new Error('SQL parameter count does not match bound values');
    }
    const result = await (this.client || this.pool).query(statement.compiled.text, statement.values);
    return { success: true, results: result.rows, meta: { changes: result.rowCount ?? 0 } };
  }

  async _transaction(callback) {
    if (this.client) return callback(this);
    const client = await this.pool.connect();
    let discard = false;
    const onError = () => { discard = true; };
    client.on('error', onError);
    try {
      await client.query('BEGIN');
      const result = await callback(new PgDatabase(this.pool, client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch { discard = true; }
      throw error;
    } finally {
      client.removeListener('error', onError);
      client.release(discard);
    }
  }

  async batch(statements) {
    if (!Array.isArray(statements) || statements.some(statement => !(statement instanceof PgStatement) || statement.database !== this)) {
      throw new TypeError('Batch statements must belong to this database');
    }
    return this._transaction(async database => {
      const results = [];
      for (const statement of statements) results.push(await database._execute(statement));
      return results;
    });
  }

  withInitializationLock(callback) {
    return this._transaction(async database => {
      await database.client.query('SELECT pg_advisory_xact_lock($1, $2)', INITIALIZATION_LOCK);
      return callback(database);
    });
  }

  withUserLock(userId, callback) {
    return this._transaction(async database => {
      // Hold this shared row lock through session insertion and commit. Password
      // and disabled-state updates must then finish before login reads them, or
      // wait and revoke the session after it commits.
      await database.prepare('SELECT id FROM nebo_users WHERE id = ? FOR SHARE').bind(userId).first();
      return callback(database);
    });
  }

  async healthCheck() {
    await this.prepare('SELECT 1 AS ready').first();
    return true;
  }

  async close() {
    if (this.client) throw new Error('Cannot close a transaction-scoped database');
    await this.pool.end();
  }
}

export function createPostgresDatabase(connectionString) {
  if (typeof connectionString !== 'string' || !connectionString.trim()) throw new Error('Missing PostgreSQL connection string');
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    idle_in_transaction_session_timeout: 15_000,
    keepAlive: true,
  });
  // An idle connection failure must not crash Node or expose a connection URL.
  pool.on('error', () => console.error('PostgreSQL idle connection failed.'));
  return new PgDatabase(pool);
}
