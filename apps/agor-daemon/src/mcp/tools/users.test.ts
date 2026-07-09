import { UsersRepository } from '@agor/core/db';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerUserTools } from './users.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('user MCP tools in sessionless context', () => {
  it('agor_users_get_current works without current session context', async () => {
    const getUser = vi.fn(async () => ({
      user_id: 'user-1',
      email: 'alice@example.com',
      role: 'member',
    }));
    let handler: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
        if (name === 'agor_users_get_current') handler = cb;
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: {
        service: (name: string) => {
          if (name !== 'users') throw new Error(`Unexpected service: ${name}`);
          return { get: getUser };
        },
      } as any,
      db: {} as any,
      userId: 'user-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'user-1', email: 'alice@example.com', role: 'member' } as any,
      baseServiceParams: {},
    });

    if (!handler) throw new Error('agor_users_get_current was not registered');
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(parsed.user_id).toBe('user-1');
    expect(getUser).toHaveBeenCalledWith('user-1', {});
  });

  it('agor_users_list paginates, searches, and returns compact rows by default', async () => {
    const findUsers = vi.fn(async () => ({
      total: 2,
      limit: 1,
      skip: 1,
      data: [
        {
          user_id: 'user-2',
          email: 'reed@preset.io',
          name: 'Reed',
          emoji: '🎸',
          role: 'member',
          unix_username: 'reed',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-01-02T00:00:00.000Z'),
          env_vars: { SECRET: { set: true, scope: 'global' } },
          default_agentic_config: { 'claude-code': { model_config: { mode: 'alias' } } },
        },
      ],
    }));
    let handler: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
        if (name === 'agor_users_list') handler = cb;
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: {
        service: (name: string) => {
          if (name !== 'users') throw new Error(`Unexpected service: ${name}`);
          return { find: findUsers };
        },
      } as any,
      db: {} as any,
      userId: 'admin-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any,
      baseServiceParams: { authenticated: true },
    });

    if (!handler) throw new Error('agor_users_list was not registered');
    const result = await handler({ limit: 1, skip: 1, search: 'reed' });
    const parsed = JSON.parse(result.content[0].text);

    expect(findUsers).toHaveBeenCalledWith({
      query: { $limit: 1, $skip: 1, search: 'reed' },
      authenticated: true,
    });
    expect(parsed).toMatchObject({ total: 2, limit: 1, skip: 1 });
    expect(parsed.data[0]).toEqual({
      user_id: 'user-2',
      email: 'reed@preset.io',
      name: 'Reed',
      emoji: '🎸',
      role: 'member',
      unix_username: 'reed',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
  });

  it('agor_users_list supports detailed and field-selected output modes', async () => {
    const detailedUser = {
      user_id: 'user-2',
      email: 'reed@preset.io',
      name: 'Reed',
      emoji: '🎸',
      role: 'member',
      unix_username: 'reed',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      env_vars: { SECRET: { set: true, scope: 'global' } },
    };
    const findUsers = vi.fn(async () => ({
      total: 1,
      limit: 50,
      skip: 0,
      data: [detailedUser],
    }));
    let handler: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
        if (name === 'agor_users_list') handler = cb;
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: {
        service: (name: string) => {
          if (name !== 'users') throw new Error(`Unexpected service: ${name}`);
          return { find: findUsers };
        },
      } as any,
      db: {} as any,
      userId: 'admin-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any,
      baseServiceParams: {},
    });

    if (!handler) throw new Error('agor_users_list was not registered');

    const detailed = JSON.parse((await handler({ lean: false })).content[0].text);
    expect(detailed.data[0]).toHaveProperty('env_vars');

    const selected = JSON.parse((await handler({ fields: ['user_id', 'emoji'] })).content[0].text);
    expect(selected.data[0]).toEqual({ user_id: 'user-2', emoji: '🎸' });
  });

  it('agor_users_find returns compact matches using the search query', async () => {
    const findUsers = vi.fn(async () => ({
      total: 1,
      limit: 10,
      skip: 0,
      data: [
        {
          user_id: 'user-2',
          email: 'reed@preset.io',
          name: 'Reed',
          emoji: '🎸',
          role: 'member',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          onboarding_completed: true,
          must_change_password: false,
        },
      ],
    }));
    let handler: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
        if (name === 'agor_users_find') handler = cb;
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: {
        service: (name: string) => {
          if (name !== 'users') throw new Error(`Unexpected service: ${name}`);
          return { find: findUsers };
        },
      } as any,
      db: {} as any,
      userId: 'admin-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any,
      baseServiceParams: {},
    });

    if (!handler) throw new Error('agor_users_find was not registered');
    const result = await handler({ search: 'Reed' });
    const parsed = JSON.parse(result.content[0].text);

    expect(findUsers).toHaveBeenCalledWith({
      query: { search: 'Reed', $limit: 10, $skip: 0 },
    });
    expect(parsed.data[0]).toEqual({
      user_id: 'user-2',
      email: 'reed@preset.io',
      name: 'Reed',
      emoji: '🎸',
      role: 'member',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('agor_users_find applies field-specific filters after broad service search', async () => {
    const findUsers = vi.fn(async () => ({
      total: 2,
      limit: 10000,
      skip: 0,
      data: [
        {
          user_id: 'user-2',
          email: 'reed@preset.io',
          name: 'Reed',
          emoji: '🎸',
          role: 'member',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          user_id: 'user-3',
          email: 'other@example.com',
          name: 'Reed Elsewhere',
          emoji: '🧪',
          role: 'member',
          created_at: new Date('2026-01-03T00:00:00.000Z'),
        },
      ],
    }));
    let handler: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (name: string, _cfg: unknown, cb: ToolHandler) => {
        if (name === 'agor_users_find') handler = cb;
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: {
        service: (name: string) => {
          if (name !== 'users') throw new Error(`Unexpected service: ${name}`);
          return { find: findUsers };
        },
      } as any,
      db: {} as any,
      userId: 'admin-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any,
      baseServiceParams: {},
    });

    if (!handler) throw new Error('agor_users_find was not registered');
    const result = await handler({ email: 'preset.io', limit: 5 });
    const parsed = JSON.parse(result.content[0].text);

    expect(findUsers).toHaveBeenCalledWith({
      query: { search: 'preset.io', $limit: 10000, $skip: 0 },
    });
    expect(parsed.total).toBe(1);
    expect(parsed.limit).toBe(5);
    expect(parsed.data.map((user: { user_id: string }) => user.user_id)).toEqual(['user-2']);
  });
});

describe('user external identity MCP tools', () => {
  function registerExternalIdentityHandlers(
    role: 'admin' | 'member' = 'admin',
    overrides: { userId?: string } = {}
  ) {
    const handlers = new Map<string, ToolHandler>();
    const configs = new Map<
      string,
      { description?: string; inputSchema: { safeParse: (args: unknown) => unknown } }
    >();
    const fakeServer = {
      registerTool: (
        name: string,
        cfg: { description?: string; inputSchema: { safeParse: (args: unknown) => unknown } },
        cb: ToolHandler
      ) => {
        handlers.set(name, cb);
        configs.set(name, cfg);
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: { service: () => ({}) } as any,
      db: {} as any,
      userId: (overrides.userId ?? 'caller-1') as any,
      sessionId: undefined,
      authenticatedUser: {
        user_id: overrides.userId ?? 'caller-1',
        email: 'caller@example.com',
        role,
      } as any,
      baseServiceParams: {},
    });

    return { handlers, configs };
  }

  it('creates a self-service Telegram link token for the current user', async () => {
    const createTokenSpy = vi
      .spyOn(UsersRepository.prototype, 'createExternalIdentityLinkToken')
      .mockResolvedValue({
        token: 'raw-token-created-once',
        token_id: 'token-1',
        user_id: 'caller-1',
        provider: 'telegram',
        issuer: 'telegram',
        purpose: 'telegram_dm_link',
        expires_at: '2026-07-09T12:15:00.000Z',
      });
    const { handlers } = registerExternalIdentityHandlers('member');
    const handler = handlers.get('agor_users_telegram_link_token_create');
    if (!handler) throw new Error('agor_users_telegram_link_token_create was not registered');

    const parsed = JSON.parse((await handler({ ttlMinutes: 10 })).content[0].text);

    expect(createTokenSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'telegram',
        issuer: 'telegram',
        purpose: 'telegram_dm_link',
        intended_user_id: 'caller-1',
        created_by_user_id: 'caller-1',
      })
    );
    expect(parsed).toMatchObject({
      status: 'created',
      user_id: 'caller-1',
      token: 'raw-token-created-once',
      usage: '/link raw-token-created-once',
    });
    expect(JSON.stringify(parsed)).not.toContain('token_hash');
  });

  it('allows admins, but not members, to create Telegram link tokens for another user', async () => {
    const createTokenSpy = vi
      .spyOn(UsersRepository.prototype, 'createExternalIdentityLinkToken')
      .mockResolvedValue({
        token: 'target-token',
        token_id: 'token-2',
        user_id: 'target-user',
        provider: 'telegram',
        issuer: 'telegram',
        purpose: 'telegram_dm_link',
        expires_at: '2026-07-09T12:15:00.000Z',
      });

    const adminHandlers = registerExternalIdentityHandlers('admin').handlers;
    await adminHandlers.get('agor_users_telegram_link_token_create')?.({
      userId: 'target-user',
    });
    expect(createTokenSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        intended_user_id: 'target-user',
        created_by_user_id: 'caller-1',
      })
    );

    const memberHandlers = registerExternalIdentityHandlers('member').handlers;
    await expect(
      memberHandlers.get('agor_users_telegram_link_token_create')?.({
        userId: 'target-user',
      })
    ).rejects.toThrow('Admin role required to create link tokens for another user.');
  });

  it('lists external identity metadata without exposing the full lookup key', async () => {
    const listSpy = vi
      .spyOn(UsersRepository.prototype, 'listExternalIdentities')
      .mockResolvedValue([
        {
          key: 'abcdefghijklmnopqrstuvwxyz1234567890',
          provider: 'telegram',
          issuer: 'telegram',
          subject: '123456789',
          name: 'telegram_username',
          last_login_at: '2026-07-09T12:00:00.000Z',
        },
      ]);
    const { handlers } = registerExternalIdentityHandlers('admin');
    const handler = handlers.get('agor_users_external_identities_list');
    if (!handler) throw new Error('agor_users_external_identities_list was not registered');

    const parsed = JSON.parse((await handler({ userId: 'user-1' })).content[0].text);

    expect(listSpy).toHaveBeenCalledWith('user-1');
    expect(parsed.external_identities).toEqual([
      {
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
        name: 'telegram_username',
        last_login_at: '2026-07-09T12:00:00.000Z',
        key_prefix: 'abcdefghijkl…',
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('links Telegram numeric user.id through repository helpers with username as metadata only', async () => {
    const linkSpy = vi.spyOn(UsersRepository.prototype, 'linkExternalIdentity').mockResolvedValue({
      user_id: 'user-1',
      email: 'target@example.com',
      role: 'member',
    } as any);
    vi.spyOn(UsersRepository.prototype, 'listExternalIdentities').mockResolvedValue([
      {
        key: 'hashed-key-for-telegram-subject',
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
        name: '@telegram_username',
        last_login_at: '2026-07-09T12:00:00.000Z',
      },
    ]);
    const { handlers } = registerExternalIdentityHandlers('admin');
    const handler = handlers.get('agor_users_external_identity_link');
    if (!handler) throw new Error('agor_users_external_identity_link was not registered');

    const parsed = JSON.parse(
      (
        await handler({
          userId: 'user-1',
          subject: ' 123456789 ',
          name: ' @telegram_username ',
          lastLoginAt: '2026-07-09T12:00:00.000Z',
        })
      ).content[0].text
    );

    expect(linkSpy).toHaveBeenCalledWith('user-1', {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
      name: '@telegram_username',
      last_login_at: '2026-07-09T12:00:00.000Z',
    });
    expect(parsed).toMatchObject({
      status: 'linked',
      user_id: 'user-1',
      external_identity: {
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
        name: '@telegram_username',
      },
    });
  });

  it('rejects non-canonical Telegram numeric subjects before repository writes', async () => {
    const linkSpy = vi
      .spyOn(UsersRepository.prototype, 'linkExternalIdentity')
      .mockResolvedValue({} as any);
    const { handlers } = registerExternalIdentityHandlers('admin');
    const handler = handlers.get('agor_users_external_identity_link');
    if (!handler) throw new Error('agor_users_external_identity_link was not registered');

    await expect(handler({ userId: 'user-1', subject: '0' })).rejects.toThrow(
      'Telegram external identity subject must be the stable numeric Telegram user.id'
    );
    await expect(handler({ userId: 'user-1', subject: '00123' })).rejects.toThrow(
      'Telegram external identity subject must be the stable numeric Telegram user.id'
    );
    expect(linkSpy).not.toHaveBeenCalled();
  });

  it('rejects Telegram usernames or non-telegram issuers as subjects before repository writes', async () => {
    const linkSpy = vi
      .spyOn(UsersRepository.prototype, 'linkExternalIdentity')
      .mockResolvedValue({} as any);
    const { handlers } = registerExternalIdentityHandlers('admin');
    const handler = handlers.get('agor_users_external_identity_link');
    if (!handler) throw new Error('agor_users_external_identity_link was not registered');

    await expect(handler({ userId: 'user-1', subject: '@telegram_username' })).rejects.toThrow(
      'Telegram external identity subject must be the stable numeric Telegram user.id'
    );
    await expect(
      handler({ userId: 'user-1', provider: 'telegram', issuer: 'botfather', subject: '123456789' })
    ).rejects.toThrow('Telegram external identity links must use issuer "telegram".');
    expect(linkSpy).not.toHaveBeenCalled();
  });

  it('requires admin role for list, link, and revoke operations', async () => {
    const listSpy = vi
      .spyOn(UsersRepository.prototype, 'listExternalIdentities')
      .mockResolvedValue([]);
    const linkSpy = vi
      .spyOn(UsersRepository.prototype, 'linkExternalIdentity')
      .mockResolvedValue({} as any);
    const unlinkSpy = vi
      .spyOn(UsersRepository.prototype, 'unlinkExternalIdentity')
      .mockResolvedValue({} as any);
    const { handlers } = registerExternalIdentityHandlers('member');

    await expect(
      handlers.get('agor_users_external_identities_list')?.({ userId: 'user-1' })
    ).rejects.toThrow('Admin role required to manage external identity links.');
    await expect(
      handlers.get('agor_users_external_identity_link')?.({
        userId: 'user-1',
        subject: '123456789',
      })
    ).rejects.toThrow('Admin role required to manage external identity links.');
    await expect(
      handlers.get('agor_users_external_identity_revoke')?.({
        userId: 'user-1',
        subject: '123456789',
      })
    ).rejects.toThrow('Admin role required to manage external identity links.');
    expect(listSpy).not.toHaveBeenCalled();
    expect(linkSpy).not.toHaveBeenCalled();
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it('revokes Telegram links locally without provider calls', async () => {
    const unlinkSpy = vi
      .spyOn(UsersRepository.prototype, 'unlinkExternalIdentity')
      .mockResolvedValue({
        user_id: 'user-1',
        email: 'target@example.com',
        role: 'member',
      } as any);
    vi.spyOn(UsersRepository.prototype, 'listExternalIdentities').mockResolvedValue([]);
    const { handlers } = registerExternalIdentityHandlers('admin');
    const handler = handlers.get('agor_users_external_identity_revoke');
    if (!handler) throw new Error('agor_users_external_identity_revoke was not registered');

    const parsed = JSON.parse(
      (await handler({ userId: 'user-1', subject: '123456789' })).content[0].text
    );

    expect(unlinkSpy).toHaveBeenCalledWith('user-1', {
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    expect(parsed).toEqual({
      status: 'revoked',
      user_id: 'user-1',
      revoked_external_identity: {
        provider: 'telegram',
        issuer: 'telegram',
        subject: '123456789',
      },
      remaining_external_identities: [],
    });
  });

  it('describes external identity tools as admin/test setup without provider calls or self-service link flow', () => {
    const { configs } = registerExternalIdentityHandlers('admin');

    expect(configs.get('agor_users_external_identity_link')?.description).toContain(
      'Admin/test setup path'
    );
    expect(configs.get('agor_users_external_identity_link')?.description).toContain(
      'No provider calls happen'
    );
    expect(configs.get('agor_users_telegram_link_token_create')?.description).toContain(
      'short-lived single-use Telegram /link token'
    );
  });
});

describe('user MCP input schemas', () => {
  it('rejects aliases and malformed required fields with caller-oriented messages', () => {
    const configs = new Map<string, { inputSchema: { safeParse: (args: unknown) => unknown } }>();
    const fakeServer = {
      registerTool: (
        name: string,
        cfg: { inputSchema: { safeParse: (args: unknown) => unknown } },
        _cb: ToolHandler
      ) => {
        configs.set(name, cfg);
      },
    } as unknown as McpServer;

    registerUserTools(fakeServer, {
      app: { service: () => ({}) } as any,
      db: {} as any,
      userId: 'admin-1' as any,
      sessionId: undefined,
      authenticatedUser: { user_id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any,
      baseServiceParams: {},
    });

    const listWithAlias = configs.get('agor_users_list')?.inputSchema.safeParse({ query: 'reed' });
    expect(listWithAlias).toMatchObject({ success: false });
    expect(JSON.stringify(listWithAlias)).toContain('query');

    const badLimit = configs
      .get('agor_users_find')
      ?.inputSchema.safeParse({ search: 'reed', limit: 0 });
    expect(badLimit).toMatchObject({ success: false });
    expect(JSON.stringify(badLimit)).toContain('limit must be greater than 0');

    const emptyCreateEmail = configs
      .get('agor_user_create')
      ?.inputSchema.safeParse({ email: '', password: 'secret' });
    expect(emptyCreateEmail).toMatchObject({ success: false });
    expect(JSON.stringify(emptyCreateEmail)).toContain('email cannot be empty');

    const emptyUserId = configs.get('agor_users_get')?.inputSchema.safeParse({ userId: '' });
    expect(emptyUserId).toMatchObject({ success: false });
    expect(JSON.stringify(emptyUserId)).toContain('userId cannot be empty');
  });
});
