/**
 * UsersRepository Tests
 *
 * Focuses on the per-tool credential mutators introduced in PR #1077:
 *   - setToolConfigField  (encrypts + persists under data.agentic_tools[tool][field])
 *   - getToolConfig       (returns full decrypted bag for a tool)
 *   - getToolConfigField  (returns single decrypted value)
 *   - deleteToolConfigField (removes field, prunes empty bucket)
 *
 * Also covers the round-trip through `update()` to verify the latent bug —
 * generic field updates nuking the encrypted credential blob — stays fixed.
 */

import type { UserID } from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, vi } from 'vitest';
import { jsonExtract, select, update } from '../database-wrapper';
import { users } from '../schema';
import { dbTest } from '../test-helpers';
import { externalIdentityKey, UsersRepository } from './users';

// Force real AES encryption for these tests so non-secret values that contain
// `:` (URLs, ports) round-trip correctly. The dev-mode fallback in
// decryptApiKey treats any `:`-containing string as encrypted format and
// rejects it — fine for prod (master secret is always set), but breaks
// fixtures that store URLs in plaintext mode.
beforeAll(() => {
  if (!process.env.AGOR_MASTER_SECRET) {
    process.env.AGOR_MASTER_SECRET = 'test-master-secret-users-repo';
  }
});

async function makeUser(repo: UsersRepository): Promise<UserID> {
  const u = await repo.create({
    email: `users-test-${Date.now()}-${Math.random()}@example.com`,
    name: 'Users Test',
  });
  return u.user_id as UserID;
}

describe('UsersRepository.findByEmailForAlignment', () => {
  dbTest('matches external-provider emails case-insensitively', async ({ db }) => {
    const repo = new UsersRepository(db);
    const suffix = `${Date.now()}-${Math.random()}`;
    const created = await repo.create({
      email: `Mixed.Case-${suffix}@Example.com`,
      name: 'Mixed Case User',
    });

    const found = await repo.findByEmailForAlignment(`mixed.case-${suffix}@example.com`);

    expect(found?.user_id).toBe(created.user_id);
  });

  dbTest('prefers exact lowercase match when case variants exist', async ({ db }) => {
    const repo = new UsersRepository(db);
    const suffix = `${Date.now()}-${Math.random()}`;
    const lower = await repo.create({
      email: `case-pref-${suffix}@example.com`,
      name: 'Lowercase User',
    });
    await repo.create({
      email: `CASE-PREF-${suffix}@example.com`,
      name: 'Uppercase User',
    });

    const found = await repo.findByEmailForAlignment(`case-pref-${suffix}@example.com`);

    expect(found?.user_id).toBe(lower.user_id);
  });

  dbTest('does not guess when only ambiguous case variants exist', async ({ db }) => {
    const repo = new UsersRepository(db);
    const suffix = `${Date.now()}-${Math.random()}`;
    await repo.create({
      email: `Ambiguous-${suffix}@example.com`,
      name: 'Ambiguous User 1',
    });
    await repo.create({
      email: `AMBIGUOUS-${suffix}@example.com`,
      name: 'Ambiguous User 2',
    });

    const found = await repo.findByEmailForAlignment(`ambiguous-${suffix}@example.com`);

    expect(found).toBeNull();
  });
});

describe('UsersRepository external identity links', () => {
  dbTest('links and finds a user by stable provider issuer subject', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);
    const linkedAt = '2026-07-08T12:00:00.000Z';

    await repo.linkExternalIdentity(userId, {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
      name: 'telegram_username',
      last_login_at: linkedAt,
    });

    const found = await repo.findByExternalIdentity({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    expect(found?.user_id).toBe(userId);

    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
    expect(row?.data.external_identities).toEqual([
      {
        key: externalIdentityKey('telegram', 'telegram', '123456789'),
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
        name: 'telegram_username',
        last_login_at: linkedAt,
      },
    ]);
  });

  dbTest('refreshes an existing external identity without duplicating it', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.linkExternalIdentity(userId, {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
      name: 'old_username',
      last_login_at: '2026-07-08T12:00:00.000Z',
    });
    await repo.linkExternalIdentity(userId, {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
      name: 'new_username',
      last_login_at: '2026-07-08T12:05:00.000Z',
    });

    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
    expect(row?.data.external_identities).toHaveLength(1);
    expect(row?.data.external_identities?.[0]).toMatchObject({
      subject: '123456789',
      name: 'new_username',
      last_login_at: '2026-07-08T12:05:00.000Z',
    });
  });

  dbTest('rejects linking the same external identity to another user', async ({ db }) => {
    const repo = new UsersRepository(db);
    const firstUserId = await makeUser(repo);
    const secondUserId = await makeUser(repo);

    await repo.linkExternalIdentity(firstUserId, {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
      name: 'telegram_username',
    });

    await expect(
      repo.linkExternalIdentity(secondUserId, {
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
        name: 'other_telegram_username',
      })
    ).rejects.toThrow(
      'External identity telegram:telegram:123456789 is already linked to another user'
    );

    const found = await repo.findByExternalIdentity({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    expect(found?.user_id).toBe(firstUserId);
  });

  dbTest('does not guess when persisted external identity links are ambiguous', async ({ db }) => {
    const repo = new UsersRepository(db);
    const firstUserId = await makeUser(repo);
    const secondUserId = await makeUser(repo);

    await repo.linkExternalIdentity(firstUserId, {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
      name: 'telegram_username',
    });

    const firstRow = await select(db).from(users).where(eq(users.user_id, firstUserId)).one();
    const secondRow = await select(db).from(users).where(eq(users.user_id, secondUserId)).one();
    expect(firstRow?.data.external_identities).toHaveLength(1);
    expect(secondRow).toBeTruthy();

    await update(db, users)
      .set({
        data: {
          ...secondRow?.data,
          external_identities: firstRow?.data.external_identities,
        },
      })
      .where(eq(users.user_id, secondUserId))
      .run();

    const found = await repo.findByExternalIdentity({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    const allMatches = await repo.findUsersByExternalIdentity({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });

    expect(found).toBeNull();
    expect(allMatches.map((user) => user.user_id).sort()).toEqual(
      [firstUserId, secondUserId].sort()
    );
  });

  dbTest('lists and revokes explicit external identity links for one user', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.linkExternalIdentity(userId, {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
      name: 'telegram_username',
      last_login_at: '2026-07-08T12:00:00.000Z',
    });

    expect(await repo.listExternalIdentities(userId)).toEqual([
      {
        key: externalIdentityKey('telegram', 'telegram', '123456789'),
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
        name: 'telegram_username',
        last_login_at: '2026-07-08T12:00:00.000Z',
      },
    ]);

    await repo.unlinkExternalIdentity(userId, {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });

    expect(await repo.listExternalIdentities(userId)).toEqual([]);
    expect(
      await repo.findByExternalIdentity({
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
      })
    ).toBeNull();
  });

  dbTest('generic user updates preserve external identity links', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.linkExternalIdentity(userId, {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
      name: 'telegram_username',
      last_login_at: '2026-07-08T12:00:00.000Z',
    });
    await repo.update(userId, { name: 'Renamed User' });

    const found = await repo.findByExternalIdentity({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    expect(found?.user_id).toBe(userId);
    expect(found?.name).toBe('Renamed User');
  });

  dbTest('does not guess unlinked external identities', async ({ db }) => {
    const repo = new UsersRepository(db);
    await makeUser(repo);

    const found = await repo.findByExternalIdentity({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '987654321',
    });

    expect(found).toBeNull();
  });

  dbTest('creates hashed Telegram link tokens and consumes them once', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    const created = await repo.createExternalIdentityLinkToken({
      provider: 'telegram',
      issuer: 'telegram',
      purpose: 'telegram_dm_link',
      intended_user_id: userId,
      created_by_user_id: userId,
      expires_at: '2099-01-01T00:00:00.000Z',
      token: 'raw-token-for-test',
    });

    expect(created.token).toBe('raw-token-for-test');
    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
    const storedToken = row?.data.external_identity_link_tokens?.[0];
    expect(storedToken?.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row?.data)).not.toContain('raw-token-for-test');

    const consumed = await repo.consumeExternalIdentityLinkToken({
      provider: 'telegram',
      issuer: 'telegram',
      purpose: 'telegram_dm_link',
      token: 'raw-token-for-test',
      subject: '123456789',
      name: '@telegram_username',
      now: new Date('2026-07-09T12:00:00.000Z'),
    });
    expect(consumed).toMatchObject({
      ok: true,
      user_id: userId,
      external_identity: {
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
        name: '@telegram_username',
      },
    });

    const after = await select(db).from(users).where(eq(users.user_id, userId)).one();
    expect(after?.data.external_identity_link_tokens?.[0]?.consumed_at).toBe(
      '2026-07-09T12:00:00.000Z'
    );
    expect(
      await repo.findByExternalIdentity({
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
      })
    ).toMatchObject({ user_id: userId });

    await expect(
      repo.consumeExternalIdentityLinkToken({
        provider: 'telegram',
        issuer: 'telegram',
        purpose: 'telegram_dm_link',
        token: 'raw-token-for-test',
        subject: '123456789',
        now: new Date('2026-07-09T12:01:00.000Z'),
      })
    ).resolves.toEqual({ ok: false, reason: 'used_token' });
  });

  dbTest('allows only one concurrent link token consumption to succeed', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.createExternalIdentityLinkToken({
      provider: 'telegram',
      issuer: 'telegram',
      purpose: 'telegram_dm_link',
      intended_user_id: userId,
      created_by_user_id: userId,
      expires_at: '2099-01-01T00:00:00.000Z',
      token: 'concurrent-token-for-test',
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        repo.consumeExternalIdentityLinkToken({
          provider: 'telegram',
          issuer: 'telegram',
          purpose: 'telegram_dm_link',
          token: 'concurrent-token-for-test',
          subject: `race-subject-${index}`,
          name: `@race_${index}`,
          now: new Date('2026-07-09T12:00:00.000Z'),
        })
      )
    );

    const successes = results.filter((result) => result.ok);
    const failures = results.filter((result) => !result.ok);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(7);
    expect(failures.map((result) => (!result.ok ? result.reason : 'ok'))).toEqual(
      Array.from({ length: 7 }, () => 'used_token')
    );
    const success = successes[0];
    expect(success?.ok).toBe(true);
    if (!success?.ok) throw new Error('Expected one successful token consumption');

    const after = await select(db).from(users).where(eq(users.user_id, userId)).one();
    expect(after?.data.external_identities).toHaveLength(1);
    expect(after?.data.external_identities?.[0]?.subject).toBe(success.external_identity.subject);
    expect(after?.data.external_identity_link_tokens?.[0]?.consumed_at).toBe(
      '2026-07-09T12:00:00.000Z'
    );

    await expect(
      repo.consumeExternalIdentityLinkToken({
        provider: 'telegram',
        issuer: 'telegram',
        purpose: 'telegram_dm_link',
        token: 'concurrent-token-for-test',
        subject: 'late-race-subject',
        now: new Date('2026-07-09T12:01:00.000Z'),
      })
    ).resolves.toEqual({ ok: false, reason: 'used_token' });
  });

  dbTest('stale same-millisecond token consume preimages fail the nonce CAS', async ({ db }) => {
    const fixedNow = new Date('2026-07-09T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    try {
      const repo = new UsersRepository(db);
      const userId = await makeUser(repo);

      await repo.createExternalIdentityLinkToken({
        provider: 'telegram',
        issuer: 'telegram',
        purpose: 'telegram_dm_link',
        intended_user_id: userId,
        created_by_user_id: userId,
        expires_at: '2099-01-01T00:00:00.000Z',
        token: 'same-millisecond-token-for-test',
      });

      const staleRow = await select(db).from(users).where(eq(users.user_id, userId)).one();
      expect(staleRow?.updated_at?.getTime()).toBe(fixedNow.getTime());
      const staleData = staleRow?.data;
      const staleNonce = staleData?.external_identity_link_token_nonce;
      expect(staleNonce).toMatch(/^[A-Za-z0-9_-]+$/);

      const consumed = await repo.consumeExternalIdentityLinkToken({
        provider: 'telegram',
        issuer: 'telegram',
        purpose: 'telegram_dm_link',
        token: 'same-millisecond-token-for-test',
        subject: 'winner-subject',
        now: fixedNow,
      });
      expect(consumed.ok).toBe(true);

      const afterWinner = await select(db).from(users).where(eq(users.user_id, userId)).one();
      expect(afterWinner?.updated_at?.getTime()).toBe(fixedNow.getTime());
      expect(afterWinner?.data.external_identity_link_token_nonce).not.toBe(staleNonce);

      const staleToken = staleData?.external_identity_link_tokens?.[0];
      expect(staleToken).toBeTruthy();
      const staleContenderData = {
        ...staleData,
        external_identities: [
          ...(staleData?.external_identities ?? []),
          {
            key: externalIdentityKey('telegram', 'telegram', 'stale-subject'),
            provider: 'telegram',
            issuer: 'telegram',
            subject: 'stale-subject',
            last_login_at: fixedNow.toISOString(),
          },
        ],
        external_identity_link_tokens: (staleData?.external_identity_link_tokens ?? []).map(
          (candidate) =>
            candidate.token_id === staleToken?.token_id
              ? {
                  ...candidate,
                  consumed_at: fixedNow.toISOString(),
                  consumed_by_subject: 'stale-subject',
                }
              : candidate
        ),
        external_identity_link_token_nonce: 'stale-contender-next-nonce',
      };
      const staleUpdate = await update(db, users)
        .set({
          data: staleContenderData,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(users.user_id, userId),
            eq(jsonExtract(db, users.data, 'external_identity_link_token_nonce'), staleNonce ?? '')
          )
        )
        .run();

      expect(staleUpdate.rowsAffected).toBe(0);
      await expect(
        repo.consumeExternalIdentityLinkToken({
          provider: 'telegram',
          issuer: 'telegram',
          purpose: 'telegram_dm_link',
          token: 'same-millisecond-token-for-test',
          subject: 'late-subject',
          now: fixedNow,
        })
      ).resolves.toEqual({ ok: false, reason: 'used_token' });

      const finalRow = await select(db).from(users).where(eq(users.user_id, userId)).one();
      expect(finalRow?.data.external_identities).toHaveLength(1);
      expect(finalRow?.data.external_identities?.[0]?.subject).toBe('winner-subject');
    } finally {
      vi.useRealTimers();
    }
  });

  dbTest('rejects expired link tokens without creating external links', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.createExternalIdentityLinkToken({
      provider: 'telegram',
      issuer: 'telegram',
      purpose: 'telegram_dm_link',
      intended_user_id: userId,
      created_by_user_id: userId,
      expires_at: '2026-07-09T12:00:00.000Z',
      token: 'expired-token-for-test',
    });

    await expect(
      repo.consumeExternalIdentityLinkToken({
        provider: 'telegram',
        issuer: 'telegram',
        purpose: 'telegram_dm_link',
        token: 'expired-token-for-test',
        subject: '123456789',
        now: new Date('2026-07-09T12:00:01.000Z'),
      })
    ).resolves.toEqual({ ok: false, reason: 'expired_token' });
    expect(
      await repo.findByExternalIdentity({
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
      })
    ).toBeNull();
  });

  dbTest('fails closed when token consumption would duplicate an existing link', async ({ db }) => {
    const repo = new UsersRepository(db);
    const tokenUserId = await makeUser(repo);
    const linkedUserId = await makeUser(repo);

    await repo.linkExternalIdentity(linkedUserId, {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    await repo.createExternalIdentityLinkToken({
      provider: 'telegram',
      issuer: 'telegram',
      purpose: 'telegram_dm_link',
      intended_user_id: tokenUserId,
      created_by_user_id: tokenUserId,
      expires_at: '2099-01-01T00:00:00.000Z',
      token: 'duplicate-link-token',
    });

    await expect(
      repo.consumeExternalIdentityLinkToken({
        provider: 'telegram',
        issuer: 'telegram',
        purpose: 'telegram_dm_link',
        token: 'duplicate-link-token',
        subject: '123456789',
        now: new Date('2026-07-09T12:00:00.000Z'),
      })
    ).resolves.toEqual({ ok: false, reason: 'already_linked' });
  });

  dbTest('generic user updates preserve pending link tokens', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.createExternalIdentityLinkToken({
      provider: 'telegram',
      issuer: 'telegram',
      purpose: 'telegram_dm_link',
      intended_user_id: userId,
      created_by_user_id: userId,
      expires_at: '2099-01-01T00:00:00.000Z',
      token: 'pending-token-for-test',
    });
    await repo.update(userId, { name: 'Renamed User' });

    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
    expect(row?.data.external_identity_link_tokens).toHaveLength(1);
    expect(JSON.stringify(row?.data)).not.toContain('pending-token-for-test');
  });
});

describe('UsersRepository.setToolConfigField + getToolConfigField', () => {
  dbTest('persists and decrypts a single field', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'secret-key');
    const got = await repo.getToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY');
    expect(got).toBe('secret-key');
  });

  dbTest('returns null for unset fields', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);
    const got = await repo.getToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY');
    expect(got).toBeNull();
  });

  dbTest('updates the same field idempotently (last write wins)', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'codex', 'OPENAI_API_KEY', 'first');
    await repo.setToolConfigField(userId, 'codex', 'OPENAI_API_KEY', 'second');

    const got = await repo.getToolConfigField(userId, 'codex', 'OPENAI_API_KEY');
    expect(got).toBe('second');
  });

  dbTest('non-secret fields (e.g. ANTHROPIC_BASE_URL) round-trip too', async ({ db }) => {
    // Storage shape is uniform — text vs password is a UI concern, not a
    // storage one. The base URL goes through the same encrypt/decrypt path.
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(
      userId,
      'claude-code',
      'ANTHROPIC_BASE_URL',
      'https://gateway.example.com'
    );
    const got = await repo.getToolConfigField(userId, 'claude-code', 'ANTHROPIC_BASE_URL');
    expect(got).toBe('https://gateway.example.com');
  });
});

describe('UsersRepository.getToolConfig', () => {
  dbTest('returns null when tool has no fields', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);
    const cfg = await repo.getToolConfig(userId, 'claude-code');
    expect(cfg).toBeNull();
  });

  dbTest('returns all decrypted fields for a single tool', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'k');
    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_BASE_URL', 'https://u');

    const cfg = await repo.getToolConfig(userId, 'claude-code');
    expect(cfg).toEqual({
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://u',
    });
  });

  dbTest('does not return other tools fields', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'a');
    await repo.setToolConfigField(userId, 'codex', 'OPENAI_API_KEY', 'o');

    const cc = await repo.getToolConfig(userId, 'claude-code');
    const cx = await repo.getToolConfig(userId, 'codex');
    expect(cc).toEqual({ ANTHROPIC_API_KEY: 'a' });
    expect(cx).toEqual({ OPENAI_API_KEY: 'o' });
  });
});

describe('UsersRepository.deleteToolConfigField', () => {
  dbTest('removes a single field and leaves siblings intact', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'k');
    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_BASE_URL', 'https://u');

    await repo.deleteToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY');

    const cfg = await repo.getToolConfig(userId, 'claude-code');
    expect(cfg).toEqual({ ANTHROPIC_BASE_URL: 'https://u' });
  });

  dbTest('prunes the bucket when the last field is removed', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'codex', 'OPENAI_API_KEY', 'o');
    await repo.deleteToolConfigField(userId, 'codex', 'OPENAI_API_KEY');

    const cfg = await repo.getToolConfig(userId, 'codex');
    expect(cfg).toBeNull();

    // The DTO presence flags should also reflect the empty state.
    const user = await repo.findById(userId);
    expect(user?.agentic_tools?.codex).toBeUndefined();
  });

  dbTest('is a no-op when the field is not set', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    // Should not throw, even though there's nothing to delete.
    await repo.deleteToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY');
    const cfg = await repo.getToolConfig(userId, 'claude-code');
    expect(cfg).toBeNull();
  });
});

describe('UsersRepository agentic_tools DTO projection', () => {
  dbTest('User.agentic_tools exposes only boolean presence flags', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'secret');
    await repo.setToolConfigField(userId, 'gemini', 'GEMINI_API_KEY', 'another');

    const user = await repo.findById(userId);
    expect(user?.agentic_tools).toEqual({
      'claude-code': { ANTHROPIC_API_KEY: true },
      gemini: { GEMINI_API_KEY: true },
    });
  });

  dbTest('omits agentic_tools when no credentials are set', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    const user = await repo.findById(userId);
    expect(user?.agentic_tools).toBeUndefined();
  });
});

describe('UsersRepository.update — credential blob preservation', () => {
  // Regression guard for the latent bug where a generic .update() (e.g.
  // changing the user's name) would round-trip through rowToUser → userToInsert
  // and zero out the encrypted agentic_tools blob because the boolean DTO
  // can't reconstruct the encrypted bytes. The fix threads the raw row into
  // the merge step.
  dbTest('updating an unrelated field preserves stored credentials', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    await repo.setToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY', 'must-survive');
    await repo.update(userId, { name: 'Renamed User' });

    const stillThere = await repo.getToolConfigField(userId, 'claude-code', 'ANTHROPIC_API_KEY');
    expect(stillThere).toBe('must-survive');

    const user = await repo.findById(userId);
    expect(user?.name).toBe('Renamed User');
    expect(user?.agentic_tools?.['claude-code']?.ANTHROPIC_API_KEY).toBe(true);
  });

  // Sibling regression: env_vars lives next to agentic_tools under data.*.
  // The repo doesn't expose a public env_vars mutator (those are managed by
  // the daemon services layer), so we patch the row directly to seed state,
  // then verify a generic .update() round-trip leaves it intact.
  dbTest('updating an unrelated field preserves stored env_vars', async ({ db }) => {
    const repo = new UsersRepository(db);
    const userId = await makeUser(repo);

    const seedEnvVars = {
      GITHUB_TOKEN: { value_encrypted: 'enc-gh-token', scope: 'global' },
    };
    const row = await select(db).from(users).where(eq(users.user_id, userId)).one();
    const currentData = (row?.data ?? {}) as Record<string, unknown>;
    await update(db, users)
      .set({ data: { ...currentData, env_vars: seedEnvVars } })
      .where(eq(users.user_id, userId))
      .run();

    await repo.update(userId, { name: 'Renamed User' });

    const after = await select(db).from(users).where(eq(users.user_id, userId)).one();
    const afterData = (after?.data ?? {}) as { env_vars?: typeof seedEnvVars };
    expect(afterData.env_vars).toEqual(seedEnvVars);
  });
});
