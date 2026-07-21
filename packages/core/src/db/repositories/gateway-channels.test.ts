/**
 * GatewayChannelRepository Tests
 *
 * Covers the created_by requirement — the contract that the
 * injectCreatedBy() hook must satisfy before calling create().
 */

import { type BranchID, GATEWAY_REDACTED_SENTINEL, type UUID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import { getRequiredSecretFields } from '../../types/gateway';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BranchRepository } from './branches';
import { GatewayChannelRepository } from './gateway-channels';
import { RepoRepository } from './repos';

async function seedBranch(db: Database) {
  const repoRepo = new RepoRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId() as UUID,
    slug: 'test/repo',
    name: 'test-repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/home/user/.agor/repos/test-repo',
    default_branch: 'main',
  });

  const branchRepo = new BranchRepository(db);
  const branch = await branchRepo.create({
    branch_id: generateId() as BranchID,
    repo_id: repo.repo_id as UUID,
    name: 'main',
    ref: 'refs/heads/main',
    branch_unique_id: 1,
    path: '/home/user/.agor/worktrees/test/repo/main',
    created_by: generateId() as UUID,
  });

  return branch;
}

describe('GatewayChannelRepository', () => {
  dbTest('create throws when created_by is missing', async ({ db }) => {
    const repo = new GatewayChannelRepository(db);
    await expect(repo.create({ name: 'Test Channel' })).rejects.toThrow(
      'GatewayChannel must have a created_by'
    );
  });

  describe('enabled requires secrets invariant', () => {
    dbTest('creates a disabled channel without secrets', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      const channel = await repo.create({
        name: 'Draft Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: false,
      });

      expect(channel.enabled).toBe(false);
      expect(channel.config.bot_token).toBeUndefined();
    });

    dbTest('rejects an enabled channel created without secrets', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      await expect(
        repo.create({
          name: 'Enabled Slack',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'slack',
          enabled: true,
        })
      ).rejects.toThrow('missing required secret(s) bot_token');
    });

    dbTest('rejects enabling a disabled token-less channel', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      const draft = await repo.create({
        name: 'Draft Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: false,
      });

      await expect(repo.update(draft.id, { enabled: true })).rejects.toThrow(
        'missing required secret(s) bot_token'
      );
    });

    dbTest('enables a draft after its secrets are supplied', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      const draft = await repo.create({
        name: 'Draft Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: false,
      });

      // Unconfigured Slack defaults to inbound, so it needs app_token too.
      const withToken = await repo.update(draft.id, {
        config: { bot_token: 'xoxb-token', app_token: 'xapp-token' },
      });
      expect(withToken.enabled).toBe(false);

      const enabled = await repo.update(draft.id, { enabled: true });
      expect(enabled.enabled).toBe(true);
      expect(enabled.config.bot_token).toBe('xoxb-token');
      expect(enabled.config.app_token).toBe('xapp-token');
    });

    dbTest('enables a channel whose stored tokens are preserved via sentinel', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      const draft = await repo.create({
        name: 'Draft Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: false,
        config: { bot_token: 'xoxb-stored', app_token: 'xapp-stored' },
      });

      const enabled = await repo.update(draft.id, {
        enabled: true,
        config: { bot_token: GATEWAY_REDACTED_SENTINEL, app_token: GATEWAY_REDACTED_SENTINEL },
      });

      expect(enabled.enabled).toBe(true);
      expect(enabled.config.bot_token).toBe('xoxb-stored');
      expect(enabled.config.app_token).toBe('xapp-stored');
    });

    dbTest('rejects enabling a token-less channel with the redaction sentinel', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      const draft = await repo.create({
        name: 'Draft Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: false,
      });

      await expect(
        repo.update(draft.id, {
          enabled: true,
          config: { bot_token: GATEWAY_REDACTED_SENTINEL },
        })
      ).rejects.toThrow('missing required secret(s) bot_token');
    });

    dbTest('rejects an enabled channel created with the redaction sentinel', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      await expect(
        repo.create({
          name: 'Enabled Slack',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'slack',
          enabled: true,
          config: { bot_token: GATEWAY_REDACTED_SENTINEL },
        })
      ).rejects.toThrow('missing required secret(s) bot_token');
    });

    dbTest('rejects an enabled Socket Mode channel missing app_token', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      // Socket Mode (inbound) needs app_token for the WebSocket handshake.
      await expect(
        repo.create({
          name: 'Inbound Slack',
          created_by: generateId() as UUID,
          target_branch_id: branch.branch_id as UUID,
          channel_type: 'slack',
          enabled: true,
          config: { connection_mode: 'socket', bot_token: 'xoxb-token' },
        })
      ).rejects.toThrow('missing required secret(s) app_token');
    });

    dbTest('enables an outbound-only Slack channel with only bot_token', async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);

      // Outbound-only channels post via chat.postMessage and never listen, so
      // they legitimately need no app_token (no connection_mode set).
      const channel = await repo.create({
        name: 'Outbound Slack',
        created_by: generateId() as UUID,
        target_branch_id: branch.branch_id as UUID,
        channel_type: 'slack',
        enabled: true,
        config: { bot_token: 'xoxb-token', outbound_enabled: true },
      });

      expect(channel.enabled).toBe(true);
      expect(channel.config.bot_token).toBe('xoxb-token');
      expect(channel.config.app_token).toBeUndefined();
    });

    dbTest(
      'rejects an enabled outbound channel that also opts into inbound surfaces',
      async ({ db }) => {
        const branch = await seedBranch(db);
        const repo = new GatewayChannelRepository(db);

        // outbound_enabled alone waives app_token, but an inbound surface flag
        // (enable_channels) means the channel must LISTEN — which needs app_token.
        await expect(
          repo.create({
            name: 'Outbound+inbound Slack',
            created_by: generateId() as UUID,
            target_branch_id: branch.branch_id as UUID,
            channel_type: 'slack',
            enabled: true,
            config: { bot_token: 'xoxb-token', outbound_enabled: true, enable_channels: true },
          })
        ).rejects.toThrow('missing required secret(s) app_token');
      }
    );
  });

  describe('getRequiredSecretFields', () => {
    it('requires app_token unless the channel explicitly opts into outbound-only', () => {
      // app_token is required for any inbound/Socket-Mode channel (needs it to
      // listen) AND for unconfigured channels (default to inbound). It is NOT
      // required only for EXPLICIT outbound-only (outbound_enabled and not
      // Socket Mode) — a socket+outbound channel is still inbound.
      expect(getRequiredSecretFields('slack', { outbound_enabled: true })).toEqual(['bot_token']);
      expect(getRequiredSecretFields('slack', {})).toEqual(['bot_token', 'app_token']);
      expect(getRequiredSecretFields('slack', { connection_mode: 'socket' })).toEqual([
        'bot_token',
        'app_token',
      ]);
      expect(
        getRequiredSecretFields('slack', { outbound_enabled: true, connection_mode: 'socket' })
      ).toEqual(['bot_token', 'app_token']);
      // An inbound surface flag (public/private/group-DM listening) forces
      // app_token even when outbound is also enabled — the channel still listens.
      expect(
        getRequiredSecretFields('slack', { outbound_enabled: true, enable_channels: true })
      ).toEqual(['bot_token', 'app_token']);
      expect(getRequiredSecretFields('telegram', {})).toEqual(['bot_token']);
    });
  });

  dbTest('requires bot_token for enabled Telegram channels', async ({ db }) => {
    const branch = await seedBranch(db);
    const repo = new GatewayChannelRepository(db);
    const userId = generateId() as UUID;

    await expect(
      repo.create({
        name: 'Telegram',
        created_by: userId,
        channel_type: 'telegram',
        target_branch_id: branch.branch_id as UUID,
        enabled: true,
        config: {},
      })
    ).rejects.toThrow('missing required secret(s) bot_token');

    const disabled = await repo.create({
      name: 'Telegram Disabled',
      created_by: userId,
      channel_type: 'telegram',
      target_branch_id: branch.branch_id as UUID,
      enabled: false,
      config: {},
    });
    expect(disabled.enabled).toBe(false);

    const enabled = await repo.create({
      name: 'Telegram Enabled',
      created_by: userId,
      channel_type: 'telegram',
      target_branch_id: branch.branch_id as UUID,
      enabled: true,
      config: { bot_token: 'telegram-token-placeholder' },
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.config.bot_token).toBe('telegram-token-placeholder');
  });

  dbTest('requires bot_token when enabling an existing Telegram channel', async ({ db }) => {
    const branch = await seedBranch(db);
    const repo = new GatewayChannelRepository(db);
    const userId = generateId() as UUID;

    const disabled = await repo.create({
      name: 'Telegram Disabled',
      created_by: userId,
      channel_type: 'telegram',
      target_branch_id: branch.branch_id as UUID,
      enabled: false,
      config: {},
    });

    await expect(repo.update(disabled.id, { enabled: true })).rejects.toThrow(
      'missing required secret(s) bot_token'
    );

    const enabled = await repo.update(disabled.id, {
      enabled: true,
      config: { bot_token: 'telegram-token-placeholder' },
    });

    expect(enabled.enabled).toBe(true);
    expect(enabled.config.bot_token).toBe('telegram-token-placeholder');
  });

  dbTest(
    'updateConfig sends only the config patch so concurrent config changes are not clobbered',
    async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const userId = generateId() as UUID;

      const channel = await repo.create({
        name: 'Telegram Enabled',
        created_by: userId,
        channel_type: 'telegram',
        target_branch_id: branch.branch_id as UUID,
        enabled: true,
        config: {
          bot_token: 'telegram-token-original',
          enable_polling: true,
        },
      });

      const realUpdate = repo.update.bind(repo);
      let injectedConcurrentChange = false;
      const updateSpy = vi.spyOn(repo, 'update').mockImplementation(async (id, updates) => {
        if (!injectedConcurrentChange) {
          injectedConcurrentChange = true;
          await realUpdate(id, {
            config: {
              bot_token: 'telegram-token-rotated',
              enable_polling: false,
            },
          });
        }
        return await realUpdate(id, updates);
      });

      const updated = await repo.updateConfig(channel.id, {
        telegram_polling_state: {
          last_processed_update_id: 456,
          acknowledged_at: '2026-07-10T12:05:00.000Z',
        },
      });

      expect(updateSpy).toHaveBeenLastCalledWith(channel.id, {
        config: {
          telegram_polling_state: {
            last_processed_update_id: 456,
            acknowledged_at: '2026-07-10T12:05:00.000Z',
          },
        },
      });
      expect(updated.config).toMatchObject({
        bot_token: 'telegram-token-rotated',
        enable_polling: false,
        telegram_polling_state: {
          last_processed_update_id: 456,
          acknowledged_at: '2026-07-10T12:05:00.000Z',
        },
      });

      updateSpy.mockRestore();
    }
  );

  dbTest(
    'updateConfig preserves existing secrets when concurrent clients hold redacted config values',
    async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const userId = generateId() as UUID;

      const channel = await repo.create({
        name: 'Telegram Enabled',
        created_by: userId,
        channel_type: 'telegram',
        target_branch_id: branch.branch_id as UUID,
        enabled: true,
        config: {
          bot_token: 'telegram-token-secret',
          enable_polling: true,
        },
      });

      await repo.update(channel.id, {
        config: {
          bot_token: GATEWAY_REDACTED_SENTINEL,
          enable_polling: false,
        },
      });

      const updated = await repo.updateConfig(channel.id, {
        telegram_polling_state: {
          last_processed_update_id: 789,
          acknowledged_at: '2026-07-10T12:10:00.000Z',
        },
      });

      expect(updated.config).toMatchObject({
        bot_token: 'telegram-token-secret',
        enable_polling: false,
        telegram_polling_state: {
          last_processed_update_id: 789,
          acknowledged_at: '2026-07-10T12:10:00.000Z',
        },
      });
    }
  );

  dbTest(
    'updateConfig merges durable channel state without replacing Telegram credentials',
    async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const userId = generateId() as UUID;

      const channel = await repo.create({
        name: 'Telegram Enabled',
        created_by: userId,
        channel_type: 'telegram',
        target_branch_id: branch.branch_id as UUID,
        enabled: true,
        config: {
          bot_token: 'telegram-token-placeholder',
          enable_polling: true,
        },
      });

      const updated = await repo.updateConfig(channel.id, {
        telegram_polling_state: {
          last_processed_update_id: 123,
          acknowledged_at: '2026-07-10T12:00:00.000Z',
        },
      });

      expect(updated.config).toMatchObject({
        bot_token: 'telegram-token-placeholder',
        enable_polling: true,
        telegram_polling_state: {
          last_processed_update_id: 123,
          acknowledged_at: '2026-07-10T12:00:00.000Z',
        },
      });
    }
  );

  dbTest('atomically grants only one active Telegram polling claim', async ({ db }) => {
    const branch = await seedBranch(db);
    const repo = new GatewayChannelRepository(db);
    const channel = await repo.create({
      name: 'Telegram Polling',
      created_by: generateId() as UUID,
      channel_type: 'telegram',
      target_branch_id: branch.branch_id as UUID,
      enabled: true,
      config: { bot_token: 'telegram-token-placeholder', enable_polling: true },
    });
    const now = new Date('2026-07-21T12:00:00.000Z');

    const claims = await Promise.all([
      repo.claimTelegramPollingUpdate(channel.id, 1000, { staleAfterMs: 60_000, now }),
      repo.claimTelegramPollingUpdate(channel.id, 1000, { staleAfterMs: 60_000, now }),
    ]);

    expect(claims.filter((claim) => claim.status === 'acquired')).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === 'active')).toHaveLength(1);
    const acquired = claims.find((claim) => claim.status === 'acquired');
    expect(acquired).toMatchObject({ status: 'acquired', reclaimed: false });
    if (acquired?.status !== 'acquired') throw new Error('Expected one acquired claim');
    await expect(repo.findById(channel.id)).resolves.toMatchObject({
      config: {
        telegram_polling_state: {
          inflight_update: {
            update_id: 1000,
            status: 'reserved',
            updated_at: now.toISOString(),
            lease_token: acquired.leaseToken,
          },
        },
      },
    });
  });

  dbTest('reclaims a stale Telegram polling claim inside the same transaction', async ({ db }) => {
    const branch = await seedBranch(db);
    const repo = new GatewayChannelRepository(db);
    const channel = await repo.create({
      name: 'Telegram Polling',
      created_by: generateId() as UUID,
      channel_type: 'telegram',
      target_branch_id: branch.branch_id as UUID,
      enabled: true,
      config: {
        bot_token: 'telegram-token-placeholder',
        telegram_polling_state: {
          inflight_update: {
            update_id: 1000,
            status: 'side_effects_started',
            updated_at: '2026-07-21T11:58:59.000Z',
            lease_token: 'old-lease',
          },
        },
      },
    });
    const now = new Date('2026-07-21T12:00:00.000Z');

    const reclaimed = await repo.claimTelegramPollingUpdate(channel.id, 1000, {
      staleAfterMs: 60_000,
      now,
    });
    expect(reclaimed).toMatchObject({ status: 'acquired', reclaimed: true });
    if (reclaimed.status !== 'acquired') throw new Error('Expected stale claim to be reclaimed');
    expect(reclaimed.leaseToken).not.toBe('old-lease');
    await expect(repo.findById(channel.id)).resolves.toMatchObject({
      config: {
        telegram_polling_state: {
          inflight_update: {
            update_id: 1000,
            status: 'reserved',
            updated_at: now.toISOString(),
            lease_token: reclaimed.leaseToken,
          },
        },
      },
    });
    await expect(
      repo.markTelegramPollingSideEffectsStarted(channel.id, 1000, 'old-lease')
    ).resolves.toBe(false);
    await expect(
      repo.markTelegramPollingSideEffectsCompleted(channel.id, 1000, 'old-lease')
    ).resolves.toBe(false);
    await expect(
      repo.acknowledgeTelegramPollingUpdate(channel.id, 1000, 'old-lease')
    ).resolves.toBe(false);
    await expect(repo.releaseTelegramPollingUpdate(channel.id, 1000, 'old-lease')).resolves.toBe(
      false
    );
  });

  dbTest(
    'owns the complete leased Telegram polling lifecycle and processed idempotency',
    async ({ db }) => {
      const branch = await seedBranch(db);
      const repo = new GatewayChannelRepository(db);
      const channel = await repo.create({
        name: 'Telegram Polling',
        created_by: generateId() as UUID,
        channel_type: 'telegram',
        target_branch_id: branch.branch_id as UUID,
        enabled: true,
        config: { bot_token: 'telegram-token-placeholder' },
      });
      const claimed = await repo.claimTelegramPollingUpdate(channel.id, 1000, {
        staleAfterMs: 60_000,
        now: new Date('2026-07-21T12:00:00.000Z'),
      });
      if (claimed.status !== 'acquired') throw new Error('Expected polling claim');

      await expect(
        repo.markTelegramPollingSideEffectsStarted(
          channel.id,
          1000,
          claimed.leaseToken,
          new Date('2026-07-21T12:00:01.000Z')
        )
      ).resolves.toBe(true);
      await expect(
        repo.markTelegramPollingSideEffectsCompleted(
          channel.id,
          1000,
          claimed.leaseToken,
          new Date('2026-07-21T12:00:02.000Z')
        )
      ).resolves.toBe(true);
      await expect(
        repo.claimTelegramPollingUpdate(channel.id, 1000, {
          staleAfterMs: 60_000,
          now: new Date('2026-07-21T12:00:03.000Z'),
        })
      ).resolves.toEqual({ status: 'side_effects_completed', leaseToken: claimed.leaseToken });
      await expect(
        repo.acknowledgeTelegramPollingUpdate(
          channel.id,
          1000,
          claimed.leaseToken,
          new Date('2026-07-21T12:00:04.000Z')
        )
      ).resolves.toBe(true);
      await expect(repo.findById(channel.id)).resolves.toMatchObject({
        config: {
          telegram_polling_state: {
            last_processed_update_id: 1000,
            acknowledged_at: '2026-07-21T12:00:04.000Z',
            recent_processed_update_ids: [1000],
          },
        },
      });
      const after = await repo.findById(channel.id);
      expect(
        (after?.config.telegram_polling_state as Record<string, unknown>).inflight_update
      ).toBeUndefined();
      await expect(
        repo.claimTelegramPollingUpdate(channel.id, 1000, {
          staleAfterMs: 60_000,
          now: new Date('2026-07-21T12:00:05.000Z'),
        })
      ).resolves.toEqual({ status: 'processed' });
    }
  );

  dbTest('create stamps created_by on the returned channel', async ({ db }) => {
    const branch = await seedBranch(db);
    const repo = new GatewayChannelRepository(db);
    const userId = generateId() as UUID;

    const channel = await repo.create({
      name: 'Test Channel',
      created_by: userId,
      target_branch_id: branch.branch_id as UUID,
      config: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
    });

    expect(channel.created_by).toBe(userId);
    expect(channel.name).toBe('Test Channel');
    expect(channel.id).toBeDefined();
  });
});
