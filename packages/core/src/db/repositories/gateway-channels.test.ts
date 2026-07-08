/**
 * GatewayChannelRepository Tests
 *
 * Covers the created_by requirement — the contract that the
 * injectCreatedBy() hook must satisfy before calling create().
 */

import type { BranchID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
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

  dbTest('create stamps created_by on the returned channel', async ({ db }) => {
    const branch = await seedBranch(db);
    const repo = new GatewayChannelRepository(db);
    const userId = generateId() as UUID;

    const channel = await repo.create({
      name: 'Test Channel',
      created_by: userId,
      target_branch_id: branch.branch_id as UUID,
    });

    expect(channel.created_by).toBe(userId);
    expect(channel.name).toBe('Test Channel');
    expect(channel.id).toBeDefined();
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
    ).rejects.toThrow(
      'config.bot_token is required to create or enable a Telegram gateway channel'
    );

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
      'config.bot_token is required to create or enable a Telegram gateway channel'
    );

    const enabled = await repo.update(disabled.id, {
      enabled: true,
      config: { bot_token: 'telegram-token-placeholder' },
    });

    expect(enabled.enabled).toBe(true);
    expect(enabled.config.bot_token).toBe('telegram-token-placeholder');
  });
});
