import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client';
import { dateTruncUtc, runTransactionWithRetry } from './database-wrapper';
import { tasks } from './schema.postgres';

describe('dateTruncUtc', () => {
  it('inlines validated PostgreSQL bucket units so SELECT/GROUP BY expressions match', () => {
    const fakePostgresDb = {} as Parameters<typeof dateTruncUtc>[0];
    const bucketExpr = dateTruncUtc(fakePostgresDb, tasks.created_at, 'week');
    const query = sql`select ${bucketExpr} as bucket from ${tasks} group by ${bucketExpr}`;

    const rendered = new PgDialect().sqlToQuery(query);

    expect(rendered.params).toEqual([]);
    expect(rendered.sql).toContain("date_trunc('week'");
    expect(rendered.sql).not.toContain('date_trunc($');
  });
});

describe('runTransactionWithRetry', () => {
  it('retries top-level and wrapped transient contention at the dialect boundary', async () => {
    const wrappedSerialization = new Error('Failed query', {
      cause: Object.assign(new Error('serialization'), { code: '40001' }),
    });
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }))
      .mockRejectedValueOnce(wrappedSerialization)
      .mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => callback({}));
    const operation = vi.fn(async () => 'done');

    await expect(
      runTransactionWithRetry({ transaction } as unknown as Database, operation)
    ).resolves.toBe('done');
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-contention or cyclic cause chains', async () => {
    const cyclic = Object.assign(new Error('constraint'), {
      code: 'SQLITE_CONSTRAINT',
    }) as Error & {
      cause?: unknown;
    };
    cyclic.cause = cyclic;
    const transaction = vi.fn().mockRejectedValue(cyclic);

    await expect(
      runTransactionWithRetry({ transaction } as unknown as Database, async () => 'unused')
    ).rejects.toBe(cyclic);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('bounds cause inspection and retains the original error after retry exhaustion', async () => {
    const tooDeep = Object.assign(new Error('outer'), { cause: undefined as unknown });
    let cursor = tooDeep;
    for (let index = 0; index < 9; index++) {
      const next = Object.assign(new Error(`cause-${index}`), { cause: undefined as unknown });
      cursor.cause = next;
      cursor = next;
    }
    Object.assign(cursor, { code: '40P01' });
    const boundedTransaction = vi.fn().mockRejectedValue(tooDeep);

    await expect(
      runTransactionWithRetry(
        { transaction: boundedTransaction } as unknown as Database,
        async () => 'unused'
      )
    ).rejects.toBe(tooDeep);
    expect(boundedTransaction).toHaveBeenCalledTimes(1);

    const exhausted = new Error('wrapped busy', {
      cause: Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }),
    });
    const retryingTransaction = vi.fn().mockRejectedValue(exhausted);
    await expect(
      runTransactionWithRetry(
        { transaction: retryingTransaction } as unknown as Database,
        async () => 'unused',
        1
      )
    ).rejects.toBe(exhausted);
    expect(retryingTransaction).toHaveBeenCalledTimes(2);
  });
});
