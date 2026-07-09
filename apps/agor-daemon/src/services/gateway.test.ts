import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { attachHiddenTenant, getCurrentTenantId, runWithTenantDatabaseScope } from '@agor/core/db';
import type { GatewayChannel, ThreadSessionMap, User } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { GatewayService, tenantIdFromGatewayChannel } from './gateway.js';

const user: User = {
  user_id: 'user-1',
  email: 'user@example.com',
  name: 'Test User',
  role: 'admin',
  is_active: true,
  created_at: '2026-06-22T00:00:00.000Z',
  updated_at: '2026-06-22T00:00:00.000Z',
  last_login_at: null,
  avatar_url: null,
  default_agentic_config: {},
  unix_username: null,
} as unknown as User;

const slackChannel: GatewayChannel = {
  id: 'chan-slack',
  name: 'Slack Bot',
  channel_type: 'slack',
  channel_key: 'slack-key',
  enabled: true,
  target_branch_id: 'branch-1',
  agor_user_id: 'user-1',
  config: { bot_token: 'xoxb-test' },
  agentic_config: null,
  created_by: 'user-1',
  created_at: '2026-06-22T00:00:00.000Z',
  updated_at: '2026-06-22T00:00:00.000Z',
  last_message_at: null,
} as unknown as GatewayChannel;

function makeMapping(overrides: Partial<ThreadSessionMap> = {}): ThreadSessionMap {
  return {
    id: 'map-1',
    channel_id: slackChannel.id,
    thread_id: 'C123-100.000000',
    session_id: 'sess-1',
    branch_id: slackChannel.target_branch_id,
    status: 'active',
    metadata: {
      slack_last_delivered_ts: '101.000000',
      slack_active_thread_id: 'C123-100.000000',
    },
    created_at: '2026-06-22T00:00:00.000Z',
    last_message_at: '2026-06-22T00:00:00.000Z',
    ...overrides,
  } as unknown as ThreadSessionMap;
}

function makeGatewayHarness(args: {
  channel?: GatewayChannel;
  existingMapping?: ThreadSessionMap | null;
  connector?: Record<string, unknown>;
  db?: TenantScopeAwareDatabase;
  externalIdentityUser?: User | null;
  externalIdentityUsers?: User[];
  alignmentUser?: User | null;
}) {
  const channel = args.channel ?? slackChannel;
  let mapping = args.existingMapping ?? null;
  const promptCreate = vi.fn(async () => ({
    task_id: 'task-1',
    session_id: mapping?.session_id ?? 'sess-new',
    status: 'running',
  }));
  const sessionsCreate = vi.fn(async () => ({
    session_id: 'sess-new',
    branch_id: channel.target_branch_id,
    status: SessionStatus.IDLE,
  }));
  const app = {
    service: (name: string) => {
      if (name === 'users')
        return {
          get: vi.fn(async (id: string) =>
            args.externalIdentityUser?.user_id === id ? args.externalIdentityUser : user
          ),
        };
      if (name === 'sessions') {
        return { create: sessionsCreate, setMCPServers: vi.fn(async () => undefined) };
      }
      if (name === '/sessions/:id/prompt') return { create: promptCreate };
      throw new Error(`Unexpected service: ${name}`);
    },
  };
  const service = new GatewayService(args.db ?? ({} as TenantScopeAwareDatabase), app as never);
  const channelRepo = {
    findByKey: vi.fn(async () => channel),
    findById: vi.fn(async () => channel),
    updateLastMessage: vi.fn(async () => undefined),
  };
  const threadMapRepo = {
    findByChannelAndThread: vi.fn(async () => mapping),
    findByChannel: vi.fn(async () => []),
    findByThread: vi.fn(async () => null),
    findBySession: vi.fn(async () => mapping),
    updateLastMessage: vi.fn(async () => undefined),
    updateMetadata: vi.fn(async (_id: string, metadata: Record<string, unknown>) => {
      if (mapping) mapping = { ...mapping, metadata } as ThreadSessionMap;
    }),
    findById: vi.fn(async () => mapping),
    create: vi.fn(async (data: Partial<ThreadSessionMap>) => {
      mapping = makeMapping({
        ...data,
        id: 'map-new',
        session_id: data.session_id ?? 'sess-new',
        metadata: data.metadata ?? null,
      });
      return mapping;
    }),
  };
  (service as unknown as { channelRepo: typeof channelRepo }).channelRepo = channelRepo;
  (service as unknown as { threadMapRepo: typeof threadMapRepo }).threadMapRepo = threadMapRepo;
  (
    service as unknown as {
      usersRepo: {
        findByExternalIdentity: (ref: {
          provider: string;
          issuer: string;
          subject: string;
        }) => Promise<User | null>;
        findUsersByExternalIdentity: (ref: {
          provider: string;
          issuer: string;
          subject: string;
        }) => Promise<User[]>;
        findByEmailForAlignment: (email: string) => Promise<User | null>;
      };
    }
  ).usersRepo = {
    findByExternalIdentity: vi.fn(async () => args.externalIdentityUser ?? null),
    findUsersByExternalIdentity: vi.fn(
      async () =>
        args.externalIdentityUsers ?? (args.externalIdentityUser ? [args.externalIdentityUser] : [])
    ),
    findByEmailForAlignment: vi.fn(async () =>
      args.alignmentUser === undefined ? user : args.alignmentUser
    ),
  };
  (
    service as unknown as { outboundRepo: { findUnconsumedByChannelAndThread: unknown } }
  ).outboundRepo = {
    findUnconsumedByChannelAndThread: vi.fn(async () => null),
  };
  (
    service as unknown as { activeListeners: Map<string, Record<string, unknown>> }
  ).activeListeners.set(channel.id, args.connector ?? {});
  (service as unknown as { hasActiveChannels: boolean }).hasActiveChannels = true;

  return { service, promptCreate, sessionsCreate, channelRepo, threadMapRepo };
}

describe('gateway tenant metadata helpers', () => {
  it('extracts non-enumerable tenant metadata from gateway channel DTOs', () => {
    const channel = attachHiddenTenant({ ...slackChannel }, { tenant_id: 'tenant-channel' });

    expect(tenantIdFromGatewayChannel(channel)).toBe('tenant-channel');
    expect(Object.keys(channel)).not.toContain('tenant_id');
  });
});

describe('GatewayService Slack thread catch-up', () => {
  it('runs listener inbound callbacks inside a fresh channel tenant DB scope', async () => {
    const seenTenants: Array<string | undefined> = [];
    const app = {
      service: vi.fn(),
    };
    const service = new GatewayService({ run: vi.fn() } as never, app as never);
    vi.spyOn(service, 'create').mockImplementation(async () => {
      seenTenants.push(getCurrentTenantId() as string | undefined);
      return { success: true, sessionId: 'sess-1', created: false };
    });

    const channel = {
      ...slackChannel,
      tenant_id: 'tenant-channel',
    } as GatewayChannel & { tenant_id: string };

    await (
      service as unknown as {
        handleListenerInboundMessage(
          channel: GatewayChannel,
          tenantId: string | undefined,
          msg: {
            threadId: string;
            text: string;
            userId: string;
            metadata?: Record<string, unknown>;
          }
        ): Promise<void>;
      }
    ).handleListenerInboundMessage(channel, channel.tenant_id, {
      threadId: 'C123-100.000000',
      text: 'hello',
      userId: 'U123',
    });

    expect(seenTenants).toEqual(['tenant-channel']);
  });

  it('passes ambient tenant context into the internal prompt call', async () => {
    const mapping = makeMapping();
    const { service, promptCreate } = makeGatewayHarness({
      existingMapping: mapping,
      connector: {},
    });

    await runWithTenantDatabaseScope({ run: vi.fn() } as never, 'tenant-channel', () =>
      service.create({
        channel_key: 'slack-key',
        thread_id: 'C123-100.000000',
        text: 'please answer',
        metadata: {
          channel: 'C123',
          channel_type: 'channel',
          slack_has_mention: true,
          slack_message_ts: '103.000000',
        },
      })
    );

    expect(promptCreate.mock.calls[0][1]).toMatchObject({
      route: { id: 'sess-1' },
      tenant: { tenant_id: 'tenant-channel', source: 'explicit' },
    });
  });

  it('fetches missed Slack messages after the last delivered cursor and advances the cursor', async () => {
    const sendMessage = vi.fn(async () => '104.000000');
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-100.000000',
      channel: 'C123',
      thread_ts: '100.000000',
      has_more: false,
      messages: [
        {
          ts: '101.000000',
          iso_time: '2026-06-22T00:00:01.000Z',
          actor_label: 'Alice',
          text: 'already seen',
          is_bot: false,
          is_trigger: false,
        },
        {
          ts: '102.000000',
          iso_time: '2026-06-22T00:00:02.000Z',
          actor_label: 'Bob',
          text: 'missed context',
          is_bot: false,
          is_trigger: false,
        },
        {
          ts: '103.000000',
          iso_time: '2026-06-22T00:00:03.000Z',
          actor_label: 'Alice',
          text: '<@U_BOT> please answer',
          is_bot: false,
          is_trigger: true,
        },
      ],
    }));
    const mapping = makeMapping({
      thread_id: 'C123-100.000000',
      metadata: {
        slack_last_delivered_ts: '101.000000',
        slack_active_thread_id: 'C123-200.000000',
      },
    });
    const { service, promptCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { fetchThreadHistory, sendMessage },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-200.000000',
      text: 'please answer',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '103.000000',
        slack_thread_ts: '100.000000',
        slack_user_name: 'Alice',
        slack_channel_name: 'eng',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-1', created: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(fetchThreadHistory).toHaveBeenCalledWith({
      threadId: 'C123-100.000000',
      oldestTs: '101.000000',
      latestTs: '103.000000',
      inclusive: true,
      limit: 200,
      includeBotMessages: false,
      triggerTs: '103.000000',
    });
    const prompt = promptCreate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(
      'Any assistant message you send in this current Agor session is streamed back directly to the Slack conversation'
    );
    expect(prompt).toContain('**Slack context**');
    expect(prompt).toContain('### Previous thread messages');
    expect(prompt).toContain('missed context');
    expect(prompt).toContain('please answer');
    expect(prompt).toContain('2026-06-22 00:00:02 UTC');
    expect(prompt).not.toContain('already seen');
    expect(prompt).not.toContain('## Slack thread context');
    expect(threadMapRepo.updateMetadata).toHaveBeenLastCalledWith(
      'map-1',
      expect.objectContaining({
        slack_last_delivered_ts: '103.000000',
        slack_last_summon_ts: '103.000000',
      })
    );
  });

  it('does not advance the Slack delivered cursor when catch-up history fetch fails', async () => {
    const fetchThreadHistory = vi.fn(async () => {
      throw new Error('slack unavailable');
    });
    const mapping = makeMapping({
      thread_id: 'C123-100.000000',
      metadata: {
        slack_last_delivered_ts: '101.000000',
        slack_active_thread_id: 'C123-200.000000',
      },
    });
    const { service, promptCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { fetchThreadHistory },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-200.000000',
      text: 'please answer',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '103.000000',
        slack_thread_ts: '100.000000',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-1', created: false });
    expect(promptCreate.mock.calls[0][0].prompt).toContain(
      'Any assistant message you send in this current Agor session is streamed back directly to the Slack conversation'
    );
    expect(promptCreate.mock.calls[0][0].prompt).toContain('please answer');
    expect(threadMapRepo.updateMetadata).not.toHaveBeenCalledWith(
      'map-1',
      expect.objectContaining({
        slack_last_delivered_ts: '103.000000',
      })
    );
    expect(warn).toHaveBeenCalledWith(
      '[gateway] Failed to fetch Slack thread catch-up context:',
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it('does not reserve a Slack thread globally across gateway channels', async () => {
    const sendMessage = vi.fn(async () => '100.000001');
    const fetchThreadHistory = vi.fn(async () => ({
      threadId: 'C123-100.000000',
      channel: 'C123',
      thread_ts: '100.000000',
      messages: [
        {
          ts: '100.000000',
          iso_time: '2026-06-22T00:00:00.000Z',
          actor_label: 'Alice',
          text: '<@U_BOT> start',
          is_bot: false,
          is_trigger: true,
        },
      ],
    }));
    const { service, sessionsCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: null,
      connector: { fetchThreadHistory, sendMessage },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-100.000000',
      text: 'start',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: true,
        slack_message_ts: '100.000000',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-new', created: true });
    expect(threadMapRepo.findByThread).not.toHaveBeenCalled();
    expect(sessionsCreate).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'C123-100.000000',
        text: expect.stringContaining('Mention me again to follow up.'),
        blocks: expect.any(Array),
      })
    );
    expect(threadMapRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: slackChannel.id,
        thread_id: 'C123-100.000000',
        session_id: 'sess-new',
      })
    );
  });

  it('rejects Slack channel-like messages that reach the gateway without an explicit mention', async () => {
    const fetchThreadHistory = vi.fn();
    const { service, promptCreate, sessionsCreate, threadMapRepo } = makeGatewayHarness({
      existingMapping: makeMapping(),
      connector: { fetchThreadHistory },
    });

    const result = await service.create({
      channel_key: 'slack-key',
      thread_id: 'C123-100.000000',
      text: 'this should not prompt',
      metadata: {
        channel: 'C123',
        channel_type: 'channel',
        slack_has_mention: false,
        slack_message_ts: '104.000000',
      },
    });

    expect(result).toEqual({ success: false, sessionId: '', created: false });
    expect(fetchThreadHistory).not.toHaveBeenCalled();
    expect(promptCreate).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(threadMapRepo.updateLastMessage).not.toHaveBeenCalled();
  });
});

describe('GatewayService Telegram alignment', () => {
  const telegramChannel: GatewayChannel = {
    ...slackChannel,
    id: 'chan-telegram',
    name: 'Telegram Bot',
    channel_type: 'telegram',
    channel_key: 'telegram-key',
    agor_user_id: 'owner-user',
    config: { bot_token: 'telegram-token' },
  } as unknown as GatewayChannel;

  const telegramUser: User = {
    ...user,
    user_id: 'telegram-user-1',
    email: 'telegram-user@example.com',
    name: 'Telegram User',
  } as unknown as User;

  it('creates a session as the explicitly linked Telegram user', async () => {
    const { service, sessionsCreate, threadMapRepo } = makeGatewayHarness({
      channel: telegramChannel,
      externalIdentityUser: telegramUser,
    });
    const usersRepo = (
      service as unknown as {
        usersRepo: { findUsersByExternalIdentity: ReturnType<typeof vi.fn> };
      }
    ).usersRepo;

    const result = await service.create({
      channel_key: 'telegram-key',
      thread_id: 'telegram:private:123456789',
      text: 'hello from telegram',
      metadata: {
        telegram_user_id: '123456789',
        telegram_external_subject: '123456789',
        telegram_username: 'not-an-identity',
        telegram_message_id: '42',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-new', created: true });
    expect(usersRepo.findUsersByExternalIdentity).toHaveBeenCalledWith({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        created_by: 'telegram-user-1',
        custom_context: {
          gateway_source: expect.objectContaining({
            channel_type: 'telegram',
            telegram_user_id: '123456789',
            telegram_username: 'not-an-identity',
          }),
        },
      })
    );
    expect(threadMapRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'chan-telegram',
        thread_id: 'telegram:private:123456789',
        session_id: 'sess-new',
      })
    );
  });

  it('rejects unlinked Telegram users instead of falling back to the channel owner', async () => {
    const { service, sessionsCreate, promptCreate } = makeGatewayHarness({
      channel: telegramChannel,
      externalIdentityUser: null,
    });

    const result = await service.create({
      channel_key: 'telegram-key',
      thread_id: 'telegram:private:123456789',
      text: 'hello from telegram',
      metadata: {
        telegram_user_id: '123456789',
        telegram_external_subject: '123456789',
        telegram_username: 'owner-user',
      },
    });

    expect(result).toEqual({ success: false, sessionId: '', created: false });
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('ignores Slack alignment metadata for Telegram and still fails closed when unlinked', async () => {
    const slackAlignedUser = {
      ...user,
      user_id: 'slack-aligned-user',
      email: 'slack-aligned@example.com',
    } as unknown as User;
    const { service, sessionsCreate, promptCreate } = makeGatewayHarness({
      channel: telegramChannel,
      externalIdentityUser: null,
      alignmentUser: slackAlignedUser,
    });
    const usersRepo = (
      service as unknown as {
        usersRepo: {
          findUsersByExternalIdentity: ReturnType<typeof vi.fn>;
          findByEmailForAlignment: ReturnType<typeof vi.fn>;
        };
      }
    ).usersRepo;

    const result = await service.create({
      channel_key: 'telegram-key',
      thread_id: 'telegram:private:123456789',
      text: 'hello from telegram',
      metadata: {
        telegram_user_id: '123456789',
        telegram_external_subject: '123456789',
        align_slack_users: true,
        slack_user_email: 'slack-aligned@example.com',
      },
    });

    expect(result).toEqual({ success: false, sessionId: '', created: false });
    expect(usersRepo.findUsersByExternalIdentity).toHaveBeenCalledWith({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    expect(usersRepo.findByEmailForAlignment).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('ignores GitHub alignment config/metadata for Telegram and still fails closed when unlinked', async () => {
    const githubAlignedUser = {
      ...user,
      user_id: 'github-aligned-user',
      email: 'github-aligned@example.com',
    } as unknown as User;
    const githubAlignedTelegramChannel = {
      ...telegramChannel,
      config: {
        bot_token: 'telegram-token',
        align_github_users: true,
        user_map: {
          octocat: 'github-aligned@example.com',
        },
      },
    } as unknown as GatewayChannel;
    const { service, sessionsCreate, promptCreate } = makeGatewayHarness({
      channel: githubAlignedTelegramChannel,
      externalIdentityUser: null,
      alignmentUser: githubAlignedUser,
    });
    const usersRepo = (
      service as unknown as {
        usersRepo: {
          findUsersByExternalIdentity: ReturnType<typeof vi.fn>;
          findByEmailForAlignment: ReturnType<typeof vi.fn>;
        };
      }
    ).usersRepo;

    const result = await service.create({
      channel_key: 'telegram-key',
      thread_id: 'telegram:private:123456789',
      text: 'hello from telegram',
      metadata: {
        telegram_user_id: '123456789',
        telegram_external_subject: '123456789',
        align_github_users: true,
        github_user: 'octocat',
        github_user_email: 'github-aligned@example.com',
      },
    });

    expect(result).toEqual({ success: false, sessionId: '', created: false });
    expect(usersRepo.findUsersByExternalIdentity).toHaveBeenCalledWith({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    expect(usersRepo.findByEmailForAlignment).not.toHaveBeenCalled();
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('uses the unique Telegram link even when cross-provider alignment flags are present', async () => {
    const crossProviderAlignedUser = {
      ...user,
      user_id: 'cross-provider-aligned-user',
      email: 'cross-provider-aligned@example.com',
    } as unknown as User;
    const crossAlignedTelegramChannel = {
      ...telegramChannel,
      config: {
        bot_token: 'telegram-token',
        align_github_users: true,
        user_map: {
          octocat: 'cross-provider-aligned@example.com',
        },
      },
    } as unknown as GatewayChannel;
    const { service, sessionsCreate } = makeGatewayHarness({
      channel: crossAlignedTelegramChannel,
      externalIdentityUser: telegramUser,
      alignmentUser: crossProviderAlignedUser,
    });
    const usersRepo = (
      service as unknown as {
        usersRepo: {
          findUsersByExternalIdentity: ReturnType<typeof vi.fn>;
          findByEmailForAlignment: ReturnType<typeof vi.fn>;
        };
      }
    ).usersRepo;

    const result = await service.create({
      channel_key: 'telegram-key',
      thread_id: 'telegram:private:123456789',
      text: 'hello from telegram',
      metadata: {
        telegram_user_id: '123456789',
        telegram_external_subject: '123456789',
        align_slack_users: true,
        align_github_users: true,
        slack_user_email: 'cross-provider-aligned@example.com',
        github_user: 'octocat',
        github_user_email: 'cross-provider-aligned@example.com',
      },
    });

    expect(result).toMatchObject({ success: true, sessionId: 'sess-new', created: true });
    expect(usersRepo.findUsersByExternalIdentity).toHaveBeenCalledWith({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    expect(usersRepo.findByEmailForAlignment).not.toHaveBeenCalled();
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        created_by: 'telegram-user-1',
      })
    );
  });

  it('rejects duplicate Telegram links instead of guessing a user', async () => {
    const secondTelegramUser = {
      ...telegramUser,
      user_id: 'telegram-user-2',
      email: 'telegram-user-2@example.com',
    } as unknown as User;
    const { service, sessionsCreate, promptCreate } = makeGatewayHarness({
      channel: telegramChannel,
      externalIdentityUsers: [telegramUser, secondTelegramUser],
    });

    const result = await service.create({
      channel_key: 'telegram-key',
      thread_id: 'telegram:private:123456789',
      text: 'hello from telegram',
      metadata: {
        telegram_user_id: '123456789',
        telegram_external_subject: '123456789',
        telegram_username: 'not-an-identity',
      },
    });

    expect(result).toEqual({ success: false, sessionId: '', created: false });
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('handles Telegram link commands without creating sessions', async () => {
    const { service, sessionsCreate, promptCreate } = makeGatewayHarness({
      channel: telegramChannel,
      externalIdentityUser: telegramUser,
    });

    const result = await service.create({
      channel_key: 'telegram-key',
      thread_id: 'telegram:private:123456789',
      text: '/link abc_DEF-1234',
      metadata: {
        telegram_user_id: '123456789',
        telegram_external_subject: '123456789',
        telegram_username: 'not-an-identity',
      },
    });

    expect(result).toEqual({ success: false, sessionId: '', created: false });
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(promptCreate).not.toHaveBeenCalled();
  });

  it('rejects Telegram messages without a normalized numeric sender id', async () => {
    const { service, sessionsCreate } = makeGatewayHarness({
      channel: telegramChannel,
      externalIdentityUser: telegramUser,
    });

    const result = await service.create({
      channel_key: 'telegram-key',
      thread_id: 'telegram:private:missing',
      text: 'hello from telegram',
      metadata: {
        telegram_username: 'not-an-identity',
      },
    });

    expect(result).toEqual({ success: false, sessionId: '', created: false });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('routes mapped Telegram sessions through connector sendMessage', async () => {
    const sendMessage = vi.fn(async () => 'telegram-message-42');
    const { service, channelRepo, threadMapRepo } = makeGatewayHarness({
      channel: telegramChannel,
      existingMapping: makeMapping({
        channel_id: telegramChannel.id,
        thread_id: 'telegram:private:123456789',
        metadata: {
          telegram_user_id: '123456789',
        },
      }),
      connector: { sendMessage },
    });

    const result = await service.routeMessage({
      session_id: 'sess-1',
      message: 'assistant response',
    });

    expect(result).toEqual({ routed: true, channelType: 'telegram' });
    expect(sendMessage).toHaveBeenCalledWith({
      threadId: 'telegram:private:123456789',
      text: 'assistant response',
      blocks: undefined,
      metadata: undefined,
    });
    expect(threadMapRepo.updateLastMessage).toHaveBeenCalledWith('map-1');
    expect(channelRepo.updateLastMessage).toHaveBeenCalledWith('chan-telegram');
  });

  it('passes Telegram connector-formatted rich payloads through the normal routeMessage path', async () => {
    const sendMessage = vi.fn(async () => 'telegram-message-42');
    const formatMessage = vi.fn(() => ({
      text: '**assistant response**',
      blocks: [{ type: 'telegram_html', parse_mode: 'HTML', text: '<b>assistant response</b>' }],
    }));
    const { service } = makeGatewayHarness({
      channel: telegramChannel,
      existingMapping: makeMapping({
        channel_id: telegramChannel.id,
        thread_id: 'telegram:private:123456789',
      }),
      connector: { sendMessage, formatMessage },
    });

    const result = await service.routeMessage({
      session_id: 'sess-1',
      message: '**assistant response**',
    });

    expect(result).toEqual({ routed: true, channelType: 'telegram' });
    expect(formatMessage).toHaveBeenCalledWith('**assistant response**');
    expect(sendMessage).toHaveBeenCalledWith({
      threadId: 'telegram:private:123456789',
      text: '**assistant response**',
      blocks: [{ type: 'telegram_html', parse_mode: 'HTML', text: '<b>assistant response</b>' }],
      metadata: undefined,
    });
  });

  it('does not route Telegram outbound for unmapped sessions', async () => {
    const sendMessage = vi.fn(async () => 'should-not-send');
    const { service, channelRepo, threadMapRepo } = makeGatewayHarness({
      channel: telegramChannel,
      existingMapping: null,
      connector: { sendMessage },
    });

    const result = await service.routeMessage({
      session_id: 'unmapped-session',
      message: 'assistant response',
    });

    expect(result).toEqual({ routed: false });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(threadMapRepo.updateLastMessage).not.toHaveBeenCalled();
    expect(channelRepo.updateLastMessage).not.toHaveBeenCalled();
  });

  it('does not route Telegram outbound when the channel is disabled or transport-disabled', async () => {
    const disabledSendMessage = vi.fn(async () => 'should-not-send');
    const disabledChannel = {
      ...telegramChannel,
      enabled: false,
    } as unknown as GatewayChannel;
    const disabledHarness = makeGatewayHarness({
      channel: disabledChannel,
      existingMapping: makeMapping({
        channel_id: disabledChannel.id,
        thread_id: 'telegram:private:123456789',
      }),
      connector: { sendMessage: disabledSendMessage },
    });

    await expect(
      disabledHarness.service.routeMessage({
        session_id: 'sess-1',
        message: 'assistant response',
      })
    ).resolves.toEqual({ routed: false });
    expect(disabledSendMessage).not.toHaveBeenCalled();
    expect(disabledHarness.threadMapRepo.updateLastMessage).not.toHaveBeenCalled();
    expect(disabledHarness.channelRepo.updateLastMessage).not.toHaveBeenCalled();

    const killSwitchSendMessage = vi.fn(async () => 'should-not-send');
    const killSwitchChannel = {
      ...telegramChannel,
      config: { bot_token: 'telegram-token', transport_disabled: true },
    } as unknown as GatewayChannel;
    const killSwitchHarness = makeGatewayHarness({
      channel: killSwitchChannel,
      existingMapping: makeMapping({
        channel_id: killSwitchChannel.id,
        thread_id: 'telegram:private:123456789',
      }),
      connector: { sendMessage: killSwitchSendMessage },
    });

    await expect(
      killSwitchHarness.service.routeMessage({
        session_id: 'sess-1',
        message: 'assistant response',
      })
    ).resolves.toEqual({ routed: false, channelType: 'telegram' });
    expect(killSwitchSendMessage).not.toHaveBeenCalled();
    expect(killSwitchHarness.threadMapRepo.updateLastMessage).not.toHaveBeenCalled();
    expect(killSwitchHarness.channelRepo.updateLastMessage).not.toHaveBeenCalled();
  });

  it('fails closed and redacts Telegram tokens/message text when outbound routing fails', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error(
        'Telegram API failed at https://api.telegram.org/bot123456:SECRET_TOKEN/sendMessage for assistant secret response'
      );
    });
    const { service } = makeGatewayHarness({
      channel: telegramChannel,
      existingMapping: makeMapping({
        channel_id: telegramChannel.id,
        thread_id: 'telegram:private:123456789',
      }),
      connector: { sendMessage },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await service.routeMessage({
        session_id: 'sess-1',
        message: 'assistant secret response',
      });

      expect(result).toEqual({ routed: false, channelType: 'telegram' });
      const logged = consoleError.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain('[redacted-telegram-token]');
      expect(logged).toContain('[redacted-message]');
      expect(logged).not.toContain('123456:SECRET_TOKEN');
      expect(logged).not.toContain('assistant secret response');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('starts Telegram polling only for enabled channels with explicit polling and bot_token', async () => {
    const enabledPollingChannel = {
      ...telegramChannel,
      id: 'chan-telegram-polling',
      config: {
        bot_token: 'telegram-token',
        enable_polling: true,
        poll_interval_ms: 60_000,
      },
    } as unknown as GatewayChannel;
    const disabledPollingChannel = {
      ...telegramChannel,
      id: 'chan-telegram-disabled',
      enabled: false,
      config: { bot_token: 'telegram-token', enable_polling: true },
    } as unknown as GatewayChannel;
    const noTokenChannel = {
      ...telegramChannel,
      id: 'chan-telegram-no-token',
      config: { enable_polling: true },
    } as unknown as GatewayChannel;
    const killSwitchChannel = {
      ...telegramChannel,
      id: 'chan-telegram-kill-switch',
      config: { bot_token: 'telegram-token', enable_polling: true, transport_disabled: true },
    } as unknown as GatewayChannel;

    const service = new GatewayService({ run: vi.fn() } as never, { service: vi.fn() } as never);
    (
      service as unknown as { channelRepo: { findAll: () => Promise<GatewayChannel[]> } }
    ).channelRepo = {
      findAll: vi.fn(async () => [
        enabledPollingChannel,
        disabledPollingChannel,
        noTokenChannel,
        killSwitchChannel,
      ]),
    };

    try {
      await service.startListeners();

      const activeListeners = (service as unknown as { activeListeners: Map<string, unknown> })
        .activeListeners;
      expect(activeListeners.has('chan-telegram-polling')).toBe(true);
      expect(activeListeners.has('chan-telegram-disabled')).toBe(false);
      expect(activeListeners.has('chan-telegram-no-token')).toBe(false);
      expect(activeListeners.has('chan-telegram-kill-switch')).toBe(false);
    } finally {
      await service.stopListeners();
    }
  });
});

describe('GatewayService Slack system message routing', () => {
  it('renders structured system messages with Slack context payloads', async () => {
    const sendMessage = vi.fn(async () => '104.000000');
    const mapping = makeMapping();
    const { service } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { sendMessage },
    });

    const result = await service.routeMessage({
      session_id: 'sess-1',
      message: '[system] Session is ready',
      metadata: { system: { render_hint: 'context' } },
    });

    expect(result).toEqual({ routed: true, channelType: 'slack' });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'C123-100.000000',
        text: expect.stringContaining('Session is ready'),
        blocks: expect.any(Array),
      })
    );
  });
});

describe('GatewayService existing outbound connector behavior', () => {
  it('keeps Slack immediate replies on the active thread path', async () => {
    const sendMessage = vi.fn(async () => '104.000000');
    const mapping = makeMapping();
    const { service } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { sendMessage },
    });

    const result = await service.routeMessage({
      session_id: 'sess-1',
      message: 'hello from agent',
    });

    expect(result).toEqual({ routed: true, channelType: 'slack' });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'C123-100.000000',
        text: 'hello from agent',
      })
    );
  });

  it('keeps GitHub routeMessage buffered until the idle flush path', async () => {
    const githubChannel = {
      ...slackChannel,
      id: 'chan-github',
      channel_type: 'github',
      config: {},
    } as unknown as GatewayChannel;
    const sendMessage = vi.fn(async () => 'should-not-send-yet');
    const { service } = makeGatewayHarness({
      channel: githubChannel,
      existingMapping: makeMapping({
        channel_id: githubChannel.id,
        thread_id: 'owner/repo#123',
      }),
      connector: { sendMessage },
    });

    const result = await service.routeMessage({
      session_id: 'sess-1',
      message: 'final github response',
    });

    expect(result).toEqual({ routed: true, channelType: 'github' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps Teams immediate replies through the active connector instance', async () => {
    const teamsChannel = {
      ...slackChannel,
      id: 'chan-teams',
      channel_type: 'teams',
      config: { app_id: 'app-id', app_password: 'app-password' },
    } as unknown as GatewayChannel;
    const sendMessage = vi.fn(async () => 'teams-message-1');
    const { service } = makeGatewayHarness({
      channel: teamsChannel,
      existingMapping: makeMapping({
        channel_id: teamsChannel.id,
        thread_id: 'conversation-id|activity-id',
      }),
      connector: { sendMessage },
    });

    const result = await service.routeMessage({
      session_id: 'sess-1',
      message: 'hello teams',
    });

    expect(result).toEqual({ routed: true, channelType: 'teams' });
    expect(sendMessage).toHaveBeenCalledWith({
      threadId: 'conversation-id|activity-id',
      text: 'hello teams',
      blocks: undefined,
      metadata: undefined,
    });
  });
});

describe('GatewayService outbound routing tenant scope', () => {
  it('defers after-hook routing until the current tenant transaction commits', async () => {
    const events: string[] = [];
    const tx = {
      execute: vi.fn(async () => []),
    };
    let transactionCount = 0;
    let resolveRouted!: () => void;
    const routed = new Promise<void>((resolve) => {
      resolveRouted = resolve;
    });
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        transactionCount += 1;
        events.push('tx:start');
        const result = await callback(tx);
        events.push('tx:commit');
        if (transactionCount === 3) resolveRouted();
        return result;
      }),
    } as TenantScopeAwareDatabase;

    const seenTenants: Array<string | undefined> = [];
    const sendMessage = vi.fn(async () => {
      events.push('send');
      seenTenants.push(getCurrentTenantId() as string | undefined);
      return '104.000000';
    });

    const { service } = makeGatewayHarness({
      db,
      existingMapping: makeMapping(),
      connector: { sendMessage },
    });

    await runWithTenantDatabaseScope(db, 'tenant-channel', async () => {
      service.routeMessageAfterCommit(
        {
          session_id: 'sess-1',
          message: 'hello from agent',
        },
        { tenant: { tenant_id: 'tenant-channel' } }
      );
      events.push('scheduled');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    await routed;

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(seenTenants).toEqual(['tenant-channel']);
    expect(events).toEqual([
      'tx:start',
      'scheduled',
      'tx:commit',
      'tx:start',
      'tx:commit',
      'tx:start',
      'send',
      'tx:commit',
    ]);
  });
});

describe('GatewayService Slack progress tenant scope', () => {
  it('defers Slack assistant status updates until the current tenant transaction commits', async () => {
    const events: string[] = [];
    const tx = {
      execute: vi.fn(async () => []),
    };
    let transactionCount = 0;
    let resolveUpdated!: () => void;
    const updated = new Promise<void>((resolve) => {
      resolveUpdated = resolve;
    });
    const db = {
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        transactionCount += 1;
        events.push('tx:start');
        const result = await callback(tx);
        events.push('tx:commit');
        if (transactionCount === 3) resolveUpdated();
        return result;
      }),
    } as TenantScopeAwareDatabase;

    const seenTenants: Array<string | undefined> = [];
    const setThreadStatus = vi.fn(async () => {
      events.push('status');
      seenTenants.push(getCurrentTenantId() as string | undefined);
    });

    const { service } = makeGatewayHarness({
      db,
      existingMapping: makeMapping(),
      connector: { setThreadStatus },
    });

    await runWithTenantDatabaseScope(db, 'tenant-channel', async () => {
      service.updateProgressAfterCommit(
        {
          session_id: 'sess-1',
          state: 'working',
          task_id: 'task-1',
          tool_name: 'Read',
        },
        { tenant: { tenant_id: 'tenant-channel' } }
      );
      events.push('scheduled');
      expect(setThreadStatus).not.toHaveBeenCalled();
    });

    await updated;

    expect(setThreadStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'C123-100.000000',
        status: 'is using Read.',
      })
    );
    expect(seenTenants).toEqual(['tenant-channel']);
    expect(events).toEqual([
      'tx:start',
      'scheduled',
      'tx:commit',
      'tx:start',
      'tx:commit',
      'tx:start',
      'status',
      'tx:commit',
    ]);
  });
});

describe('GatewayService Slack streaming', () => {
  it('does not stream assistant chunks into channel-like Slack threads', async () => {
    const startStream = vi.fn(async () => '104.000000');
    const appendStream = vi.fn(async () => undefined);
    const mapping = makeMapping({
      metadata: {
        slack_active_thread_id: 'C123-100.000000',
        slack_user_id: 'U1',
        slack_team_id: 'T1',
      },
    });
    const { service } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { startStream, appendStream },
    });

    await service.handleMessageStreamingEvent('streaming:start', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
    });
    await service.handleMessageStreamingEvent('streaming:chunk', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
      chunk: 'hello channel',
    });

    expect(startStream).not.toHaveBeenCalled();
    expect(appendStream).not.toHaveBeenCalled();
    expect(service.wasTaskStreamedToSlack?.('task-1')).toBe(false);
  });

  it('keeps streaming enabled for Slack DMs', async () => {
    const startStream = vi.fn(async () => '104.000000');
    const appendStream = vi.fn(async () => undefined);
    const mapping = makeMapping({
      thread_id: 'D123-100.000000',
      metadata: { slack_active_thread_id: 'D123-100.000000' },
    });
    const { service } = makeGatewayHarness({
      existingMapping: mapping,
      connector: { startStream, appendStream },
    });

    await service.handleMessageStreamingEvent('streaming:start', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
    });
    await service.handleMessageStreamingEvent('streaming:chunk', {
      session_id: 'sess-1',
      message_id: 'msg-1',
      task_id: 'task-1',
      chunk: 'hello dm',
    });

    expect(startStream).toHaveBeenCalledWith({
      threadId: 'D123-100.000000',
      text: 'hello dm',
      recipientUserId: undefined,
      recipientTeamId: undefined,
    });
    expect(service.wasTaskStreamedToSlack?.('task-1')).toBe(true);
  });
});
