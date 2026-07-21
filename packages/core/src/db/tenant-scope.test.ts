import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client';
import { insert } from './database-wrapper';
import {
  createTenantScopedDatabaseProxy,
  enqueueTenantDatabasePostCommitCallback,
  getCurrentTenantId,
  MissingTenantDatabaseScopeError,
  requireCurrentTenantId,
  runWithIdempotentTenantDatabaseScopeRetry,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
} from './tenant-scope';

describe('tenant-scoped database proxy', () => {
  it('routes repository-style calls to the active tenant transaction', async () => {
    const tx = {
      execute: vi.fn(async () => []),
      marker: vi.fn(() => 'tx'),
    };
    const base = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    expect((db as unknown as { marker(): string }).marker()).toBe('base');

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('tx');
    });

    expect(base.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('runs post-commit callbacks after the scoped transaction commits', async () => {
    const events: string[] = [];
    const base = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        events.push('begin');
        const result = await callback({
          execute: vi.fn(async () => []),
          marker: vi.fn(() => 'tx'),
        });
        events.push('commit');
        return result;
      }),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      events.push('work');
      expect(
        enqueueTenantDatabasePostCommitCallback(async () => {
          events.push('callback');
        })
      ).toBe(true);
    });

    expect(events).toEqual(['begin', 'work', 'commit', 'begin', 'callback', 'commit']);
  });

  it('reuses the active tenant transaction for nested scopes', async () => {
    const tx = {
      execute: vi.fn(async () => []),
      marker: vi.fn(() => 'tx'),
    };
    const base = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('tx');
      await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
        expect((db as unknown as { marker(): string }).marker()).toBe('tx');
      });
    });

    expect(base.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('retries outer commit contention only for explicitly idempotent tenant work', async () => {
    const events: string[] = [];
    let transactionAttempt = 0;
    const base = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        transactionAttempt += 1;
        const marker = `tx-${transactionAttempt}`;
        events.push(`begin:${marker}`);
        const result = await callback({
          execute: vi.fn(async () => []),
          marker: vi.fn(() => marker),
        });
        if (transactionAttempt === 1) {
          events.push(`contention:${marker}`);
          throw Object.assign(new Error('outer commit serialization failure'), {
            cause: { code: '40001' },
          });
        }
        events.push(`commit:${marker}`);
        return result;
      }),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    await runWithIdempotentTenantDatabaseScopeRetry(db, 'tenant-a', async () => {
      events.push(`work:${(db as unknown as { marker(): string }).marker()}`);
    });

    expect(events).toEqual([
      'begin:tx-1',
      'work:tx-1',
      'contention:tx-1',
      'begin:tx-2',
      'work:tx-2',
      'commit:tx-2',
    ]);
    expect(base.transaction).toHaveBeenCalledTimes(2);
  });

  it('rejects nested scopes that try to switch tenants', async () => {
    const tx = {
      execute: vi.fn(async () => []),
    };
    const base = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    await expect(
      runWithTenantDatabaseScope(db, 'tenant-a', async () =>
        runWithTenantDatabaseScope(db, 'tenant-b', async () => undefined)
      )
    ).rejects.toThrow(/Cannot enter tenant scope tenant-b/);

    expect(base.transaction).toHaveBeenCalledTimes(1);
  });

  it('does not recursively route to itself for SQLite no-op scopes', async () => {
    const base = {
      run: vi.fn(),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('base');
    });
  });

  it('does not recursively route to itself for unscoped PostgreSQL calls', async () => {
    const base = {
      transaction: vi.fn(),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);

    await runWithTenantDatabaseScope(db, undefined, async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('base');
    });

    expect(base.transaction).not.toHaveBeenCalled();
  });

  it('stamps tenant_id into wrapped inserts for tenant-aware tables', async () => {
    const captured: unknown[] = [];
    const tx = {
      execute: vi.fn(async () => []),
      insert: vi.fn(() => ({
        values: vi.fn((value: unknown) => {
          captured.push(value);
          return {};
        }),
      })),
    };
    const base = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);
    const tenantAwareTable = { tenant_id: {} } as never;

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      insert(db, tenantAwareTable).values({ id: 'row-1', name: 'Example' });
      insert(db, tenantAwareTable).values([
        { id: 'row-2' },
        { id: 'row-3', tenant_id: 'explicit' },
      ]);
    });

    expect(captured).toEqual([
      { tenant_id: 'tenant-a', id: 'row-1', name: 'Example' },
      [
        { tenant_id: 'tenant-a', id: 'row-2' },
        { id: 'row-3', tenant_id: 'explicit' },
      ],
    ]);
  });

  it('supports requiring and explicitly escaping the ambient tenant scope', async () => {
    const base = {
      run: vi.fn(),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database);
    const seen: Array<string | undefined> = [];

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      expect(requireCurrentTenantId()).toBe('tenant-a');
      seen.push(getCurrentTenantId());
      runWithoutTenantDatabaseScope(() => {
        seen.push(getCurrentTenantId());
        expect(() => requireCurrentTenantId()).toThrow('Missing active tenant context');
      });
      seen.push(getCurrentTenantId());
    });

    expect(seen).toEqual(['tenant-a', undefined, 'tenant-a']);
  });

  it('guarded proxies reject DB access without tenant or system scope', async () => {
    const base = {
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database, {
      requireScope: true,
      label: 'test db',
    });

    expect(() => (db as unknown as { marker(): string }).marker()).toThrow(
      MissingTenantDatabaseScopeError
    );
    expect(() => (db as unknown as { marker(): string }).marker()).toThrow(
      'Missing tenant database scope for test db access'
    );
  });
  it('guarded proxies allow tenant-scoped and explicit system-scoped DB access', async () => {
    const base = {
      run: vi.fn(),
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database, {
      requireScope: true,
    });

    await runWithTenantDatabaseScope(db, 'tenant-a', async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('base');
    });

    await runWithSystemDatabaseScope(db, 'test global setup', async () => {
      expect((db as unknown as { marker(): string }).marker()).toBe('base');
    });
  });

  it('does not allow switching from explicit system scope into tenant scope', async () => {
    const base = {
      marker: vi.fn(() => 'base'),
    };
    const db = createTenantScopedDatabaseProxy(base as unknown as Database, {
      requireScope: true,
    });

    await expect(
      runWithSystemDatabaseScope(db, 'test global setup', async () =>
        runWithTenantDatabaseScope(db, 'tenant-a', async () => undefined)
      )
    ).rejects.toThrow(/Cannot enter tenant scope tenant-a from active system database scope/);
  });
});
