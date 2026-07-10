import { describe, expect, it, vi } from 'vitest';
import { getConnector, hasConnector } from '../connector-registry';
import {
  decideTelegramInboundAuth,
  handleTelegramUpdate,
  markdownToTelegramHtml,
  normalizeTelegramInboundUpdate,
  parseTelegramCommandIntent,
  parseTelegramPrivateThreadId,
  TelegramConnector,
  telegramExternalIdentityRef,
} from './telegram';

describe('normalizeTelegramInboundUpdate', () => {
  it('accepts private text DMs and uses numeric from.id as the external subject', () => {
    const result = normalizeTelegramInboundUpdate({
      update_id: 1000,
      message: {
        message_id: 42,
        date: 1_788_888_888,
        chat: { id: 123456789, type: 'private', username: 'chat_user' },
        from: {
          id: 123456789,
          is_bot: false,
          username: 'trusted-looking-username',
          first_name: 'Ada',
        },
        text: '  hello from Telegram  ',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      message: {
        threadId: 'telegram:private:123456789',
        text: 'hello from Telegram',
        userId: '123456789',
        metadata: {
          telegram_user_id: '123456789',
          telegram_external_subject: '123456789',
          telegram_username: 'trusted-looking-username',
          telegram_identity_provider: 'telegram',
          telegram_identity_issuer: 'telegram',
        },
      },
    });
  });

  it.each([
    ['group', { message: { chat: { type: 'group' }, from: { id: 1 }, text: 'hello' } }],
    ['supergroup', { message: { chat: { type: 'supergroup' }, from: { id: 1 }, text: 'hello' } }],
    ['channel', { message: { chat: { type: 'channel' }, from: { id: 1 }, text: 'hello' } }],
    ['channel_post', { channel_post: { chat: { type: 'channel' }, text: 'hello' } }],
  ])('rejects unsupported Telegram update/chat shape: %s', (_label, update) => {
    const result = normalizeTelegramInboundUpdate(update);

    expect(result.ok).toBe(false);
  });

  it('rejects missing or non-numeric sender ids', () => {
    expect(
      normalizeTelegramInboundUpdate({
        message: { chat: { type: 'private' }, from: {}, text: 'hello' },
      })
    ).toEqual({ ok: false, reason: 'missing_sender_id' });

    expect(
      normalizeTelegramInboundUpdate({
        message: { chat: { type: 'private' }, from: { id: '123456789' }, text: 'hello' },
      })
    ).toEqual({ ok: false, reason: 'missing_sender_id' });
  });

  it('normalizes Telegram documents with caption as untrusted attachment metadata', () => {
    const result = normalizeTelegramInboundUpdate({
      update_id: 1001,
      message: {
        message_id: 43,
        date: 1_788_888_888,
        chat: { id: 123456789, type: 'private' },
        from: { id: 123456789, is_bot: false },
        caption: 'please inspect this',
        document: {
          file_id: 'telegram-file-id',
          file_name: '../unsafe:name.pdf',
          mime_type: 'application/pdf',
          file_size: 1234,
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      message: {
        text: 'please inspect this',
        attachments: [
          {
            id: 'telegram-file-id',
            kind: 'file',
            filename: 'unsafe_name.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1234,
            caption: 'please inspect this',
            metadata: {
              telegram_file_id: 'telegram-file-id',
              telegram_attachment_type: 'document',
            },
          },
        ],
      },
    });
  });

  it('normalizes Telegram photos as safe image attachments', () => {
    const result = normalizeTelegramInboundUpdate({
      update_id: 1002,
      message: {
        message_id: 44,
        date: 1_788_888_888,
        chat: { id: 123456789, type: 'private' },
        from: { id: 123456789, is_bot: false },
        photo: [
          { file_id: 'small-photo', width: 90, height: 90, file_size: 100 },
          { file_id: 'large-photo', width: 1280, height: 720, file_size: 2000 },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      message: {
        text: 'Telegram attachment received.',
        attachments: [
          {
            id: 'large-photo',
            kind: 'image',
            filename: 'telegram-photo-44.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 2000,
            metadata: {
              telegram_file_id: 'large-photo',
              telegram_attachment_type: 'photo',
            },
          },
        ],
      },
    });
  });

  it.each([
    ['voice', { voice: { file_id: 'file' } }],
    ['video', { video: { file_id: 'file' } }],
    ['audio', { audio: { file_id: 'file' } }],
  ])('normalizes unsupported Telegram media as an attachment rejection: %s', (_label, extraMessageFields) => {
    const result = normalizeTelegramInboundUpdate({
      message: {
        chat: { type: 'private' },
        from: { id: 123456789, is_bot: false },
        ...extraMessageFields,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      message: {
        attachmentRejection: {
          reason: 'unsupported_type',
        },
      },
    });
  });

  it.each([
    ['web_app_data', { web_app_data: { data: '{}' } }],
  ])('rejects non-text/non-attachment messages: %s', (_label, extraMessageFields) => {
    const result = normalizeTelegramInboundUpdate({
      message: {
        chat: { type: 'private' },
        from: { id: 123456789, is_bot: false },
        ...extraMessageFields,
      },
    });

    expect(result).toEqual({ ok: false, reason: 'unsupported_message_content' });
  });

  it('rejects bot senders', () => {
    const result = normalizeTelegramInboundUpdate({
      message: {
        chat: { type: 'private' },
        from: { id: 123456789, is_bot: true },
        text: 'hello',
      },
    });

    expect(result).toEqual({ ok: false, reason: 'bot_sender' });
  });

  it('does not trust usernames as identity', () => {
    const first = normalizeTelegramInboundUpdate({
      message: {
        chat: { type: 'private' },
        from: { id: 111, is_bot: false, username: 'same_username' },
        text: 'hello',
      },
    });
    const second = normalizeTelegramInboundUpdate({
      message: {
        chat: { type: 'private' },
        from: { id: 222, is_bot: false, username: 'same_username' },
        text: 'hello',
      },
    });

    expect(first.ok && first.message.metadata?.telegram_external_subject).toBe('111');
    expect(second.ok && second.message.metadata?.telegram_external_subject).toBe('222');
  });
});

describe('Telegram explicit link/auth helpers', () => {
  it('builds external identity refs from stable numeric Telegram ids only', () => {
    expect(telegramExternalIdentityRef(123456789)).toEqual({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    expect(telegramExternalIdentityRef('123456789')).toEqual({
      provider: 'telegram',
      issuer: 'telegram',
      subject: '123456789',
    });
    expect(telegramExternalIdentityRef('username')).toBeNull();
    expect(telegramExternalIdentityRef(0)).toBeNull();
  });

  it('resolves exactly one explicitly linked Agor user', () => {
    expect(
      decideTelegramInboundAuth({
        telegramUserId: 123456789,
        linkedUsers: [{ user_id: 'agor-user-1' }],
      })
    ).toEqual({
      ok: true,
      telegramUserId: '123456789',
      agorUserId: 'agor-user-1',
    });
  });

  it('fails closed for unlinked Telegram users', () => {
    expect(
      decideTelegramInboundAuth({
        telegramUserId: 123456789,
        linkedUsers: [],
      })
    ).toEqual({
      ok: false,
      reason: 'unlinked_user',
      telegramUserId: '123456789',
    });
  });

  it('fails closed for duplicate/ambiguous Telegram links', () => {
    expect(
      decideTelegramInboundAuth({
        telegramUserId: 123456789,
        linkedUsers: [{ user_id: 'agor-user-1' }, { user_id: 'agor-user-2' }],
      })
    ).toEqual({
      ok: false,
      reason: 'ambiguous_link',
      telegramUserId: '123456789',
    });
  });

  it('does not use usernames as a fallback identity', () => {
    expect(
      decideTelegramInboundAuth({
        telegramUserId: 'trusted_username',
        linkedUsers: [{ user_id: 'agor-user-1' }],
      })
    ).toEqual({ ok: false, reason: 'missing_numeric_sender_id' });
  });
});

describe('Telegram command/link boundary', () => {
  it('parses /help without mutating or requiring identity', () => {
    expect(parseTelegramCommandIntent('/help')).toEqual({ kind: 'help' });
    expect(parseTelegramCommandIntent('/help@AgorBot anything else')).toEqual({ kind: 'help' });
  });

  it('parses /new reset and /new initial prompt intents', () => {
    expect(parseTelegramCommandIntent('/new')).toEqual({ kind: 'new_session' });
    expect(parseTelegramCommandIntent('/new@AgorBot')).toEqual({ kind: 'new_session' });
    expect(parseTelegramCommandIntent('/new please start fresh')).toEqual({
      kind: 'new_session',
      prompt: 'please start fresh',
    });
  });

  it('parses /link help without mutating or requiring identity', () => {
    expect(parseTelegramCommandIntent('/link')).toEqual({ kind: 'link_help' });
    expect(parseTelegramCommandIntent('/link@AgorBot')).toEqual({ kind: 'link_help' });
  });

  it('parses /link token verification intent only with a numeric Telegram sender id', () => {
    expect(parseTelegramCommandIntent('/link abc_DEF-1234', 123456789)).toEqual({
      kind: 'link_token',
      token: 'abc_DEF-1234',
      telegramUserId: '123456789',
    });
    expect(parseTelegramCommandIntent('/link abc_DEF-1234', 'username')).toEqual({
      kind: 'invalid_link_token',
      reason: 'missing_numeric_sender_id',
    });
  });

  it('rejects unsafe link token shapes and marks other slash commands unsupported', () => {
    expect(parseTelegramCommandIntent('/link short', 123456789)).toEqual({
      kind: 'invalid_link_token',
      reason: 'invalid_token',
    });
    expect(parseTelegramCommandIntent('/unknown please')).toEqual({
      kind: 'unsupported_command',
      command: 'unknown',
    });
    expect(parseTelegramCommandIntent('regular prompt')).toEqual({ kind: 'regular_message' });
  });
});

describe('handleTelegramUpdate transport bridge', () => {
  it('routes accepted Telegram DMs through the gateway callback with audit metadata', () => {
    const callback = vi.fn();

    const result = handleTelegramUpdate(
      {
        update_id: 1000,
        message: {
          message_id: 42,
          date: 1_788_888_888,
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789, is_bot: false },
          text: 'hello bridge',
        },
      },
      callback,
      { transport: 'polling', now: () => new Date('2026-07-08T12:00:00.000Z') }
    );

    expect(result).toMatchObject({
      ok: true,
      message: {
        threadId: 'telegram:private:123456789',
        metadata: {
          telegram_transport: 'polling',
          telegram_received_at: '2026-07-08T12:00:00.000Z',
          telegram_update_id: 1000,
        },
      },
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello bridge',
        metadata: expect.objectContaining({
          telegram_external_subject: '123456789',
          telegram_transport: 'polling',
        }),
      })
    );
  });

  it('fails closed before callback for unsupported updates and rate-limited messages', () => {
    const callback = vi.fn();

    expect(handleTelegramUpdate({ channel_post: {} }, callback)).toEqual({
      ok: false,
      reason: 'unsupported_update_shape',
    });
    expect(
      handleTelegramUpdate(
        {
          update_id: 1000,
          message: {
            chat: { type: 'private' },
            from: { id: 123456789, is_bot: false },
            text: 'hello',
          },
        },
        callback,
        { rateLimit: () => false }
      )
    ).toEqual({ ok: false, reason: 'rate_limited' });
    expect(callback).not.toHaveBeenCalled();
  });
});

describe('TelegramConnector polling lifecycle', () => {
  it('is registered as a native gateway connector without removing existing providers', () => {
    expect(hasConnector('slack')).toBe(true);
    expect(hasConnector('github')).toBe(true);
    expect(hasConnector('teams')).toBe(true);
    expect(hasConnector('telegram')).toBe(true);
    expect(getConnector('telegram', {})).toBeInstanceOf(TelegramConnector);
  });

  it('polls only when explicitly enabled and routes fake updates without provider mutation', async () => {
    const getUpdates = vi.fn(async () => [
      {
        update_id: 1000,
        message: {
          message_id: 42,
          date: 1_788_888_888,
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789, is_bot: false },
          text: 'hello fake polling',
        },
      },
    ]);
    const setWebhook = vi.fn();
    const deleteWebhook = vi.fn();
    const callback = vi.fn();
    const connector = new TelegramConnector(
      {
        bot_token: 'telegram-token',
        enable_polling: true,
        poll_interval_ms: 1000,
      },
      {
        client: { getUpdates, setWebhook, deleteWebhook } as never,
        setInterval: vi.fn(() => 123 as never) as never,
        clearInterval: vi.fn() as never,
        now: () => new Date('2026-07-08T12:00:00.000Z'),
      }
    );

    await connector.startListening(callback);
    await connector.pollOnce(callback);
    await connector.stopListening();

    expect(getUpdates).toHaveBeenCalledWith({
      botToken: 'telegram-token',
    });
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'hello fake polling',
        metadata: expect.objectContaining({
          telegram_transport: 'polling',
          telegram_update_id: 1000,
        }),
      })
    );
    expect(setWebhook).not.toHaveBeenCalled();
    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it('seeds polling offset from persisted channel state', async () => {
    const getUpdates = vi.fn(async () => []);
    const connector = new TelegramConnector(
      {
        bot_token: 'telegram-token',
        enable_polling: true,
        telegram_polling_state: {
          last_processed_update_id: 1000,
        },
      },
      { client: { getUpdates } }
    );

    await connector.pollOnce(vi.fn());

    expect(getUpdates).toHaveBeenCalledWith({
      botToken: 'telegram-token',
      offset: 1001,
    });
  });

  it('does not advance polling offset until the gateway callback resolves', async () => {
    const getUpdates = vi.fn(async () => [
      {
        update_id: 1000,
        message: {
          message_id: 42,
          date: 1_788_888_888,
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789, is_bot: false },
          text: 'retry me',
        },
      },
    ]);
    const callback = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary gateway failure'))
      .mockResolvedValueOnce(undefined);
    const connector = new TelegramConnector(
      {
        bot_token: 'telegram-token',
        enable_polling: true,
      },
      { client: { getUpdates } }
    );

    await connector.pollOnce(callback);
    await connector.pollOnce(callback);
    await connector.pollOnce(callback);

    expect(getUpdates.mock.calls[0][0]).toEqual({ botToken: 'telegram-token' });
    expect(getUpdates.mock.calls[1][0]).toEqual({ botToken: 'telegram-token' });
    expect(getUpdates.mock.calls[2][0]).toEqual({ botToken: 'telegram-token', offset: 1001 });
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('redacts inbound polling text from callback failure logs', async () => {
    const secretText = 'private payroll question from telegram';
    const getUpdates = vi.fn(async () => [
      {
        update_id: 1000,
        message: {
          message_id: 42,
          date: 1_788_888_888,
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789, is_bot: false },
          text: secretText,
        },
      },
    ]);
    const callback = vi.fn(async () => {
      throw new Error(`callback failed while handling ${secretText} telegram-token`);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const connector = new TelegramConnector(
      {
        bot_token: 'telegram-token',
        enable_polling: true,
      },
      { client: { getUpdates } }
    );

    let logged = '';
    try {
      await connector.pollOnce(callback);
      logged = warnSpy.mock.calls.flat().join(' ');
    } finally {
      warnSpy.mockRestore();
    }

    expect(logged).toContain('[redacted-message]');
    expect(logged).not.toContain(secretText);
  });

  it('redacts bot tokens from polling fetch failure logs without advancing the retry offset', async () => {
    const botToken = '123456:SECRET_TOKEN';
    const tokenBearingUrl = `https://api.telegram.org/bot${botToken}/getUpdates`;
    const getUpdates = vi
      .fn()
      .mockRejectedValueOnce(new Error(`fetch failed for ${tokenBearingUrl}`))
      .mockResolvedValueOnce([]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const connector = new TelegramConnector(
      {
        bot_token: botToken,
        enable_polling: true,
      },
      { client: { getUpdates } }
    );

    let logged = '';
    try {
      await connector.pollOnce(vi.fn());
      logged = warnSpy.mock.calls.flat().join(' ');
      await connector.pollOnce(vi.fn());
    } finally {
      warnSpy.mockRestore();
    }

    expect(logged).toContain('[telegram] Poll tick failed:');
    expect(logged).toContain('[redacted-telegram-token]');
    expect(logged).not.toContain(botToken);
    expect(logged).not.toContain(tokenBearingUrl);
    expect(getUpdates.mock.calls[0][0]).toEqual({ botToken });
    expect(getUpdates.mock.calls[1][0]).toEqual({ botToken });
  });

  it('advances polling offset for terminal adapter-level ignored updates', async () => {
    const getUpdates = vi
      .fn()
      .mockResolvedValueOnce([{ update_id: 1000, channel_post: { text: 'unsupported' } }])
      .mockResolvedValueOnce([]);
    const callback = vi.fn();
    const connector = new TelegramConnector(
      {
        bot_token: 'telegram-token',
        enable_polling: true,
      },
      { client: { getUpdates } }
    );

    await connector.pollOnce(callback);
    await connector.pollOnce(callback);

    expect(callback).not.toHaveBeenCalled();
    expect(getUpdates.mock.calls[1][0]).toEqual({ botToken: 'telegram-token', offset: 1001 });
  });

  it('does not poll disabled, kill-switched, or tokenless connector configs', async () => {
    const getUpdates = vi.fn(async () => []);

    const disabled = new TelegramConnector(
      { bot_token: 'telegram-token', enable_polling: false },
      { client: { getUpdates } }
    );
    await disabled.startListening(vi.fn());
    await disabled.pollOnce(vi.fn());
    expect(getUpdates).not.toHaveBeenCalled();

    const killSwitched = new TelegramConnector(
      { bot_token: 'telegram-token', enable_polling: true, transport_disabled: true },
      { client: { getUpdates } }
    );
    await killSwitched.startListening(vi.fn());
    await killSwitched.pollOnce(vi.fn());
    expect(getUpdates).not.toHaveBeenCalled();

    const tokenless = new TelegramConnector({ enable_polling: true }, { client: { getUpdates } });
    await expect(tokenless.startListening(vi.fn())).rejects.toThrow(
      'Telegram connector requires bot_token to start polling'
    );
    expect(getUpdates).not.toHaveBeenCalled();
  });
});

describe('TelegramConnector outbound private DM replies', () => {
  it('parses only private Telegram DM thread IDs', () => {
    expect(parseTelegramPrivateThreadId('telegram:private:123456789')).toBe('123456789');
    expect(() => parseTelegramPrivateThreadId('telegram:group:123456789')).toThrow(
      'Invalid Telegram private DM thread ID'
    );
    expect(() => parseTelegramPrivateThreadId('telegram:private:0')).toThrow(
      'Invalid Telegram private DM thread ID'
    );
    expect(() => parseTelegramPrivateThreadId('telegram:private:00123')).toThrow(
      'Invalid Telegram private DM thread ID'
    );
    expect(() => parseTelegramPrivateThreadId('telegram:private:not-numeric')).toThrow(
      'Invalid Telegram private DM thread ID'
    );
  });

  it('sends text-only replies to the parsed Telegram chat id', async () => {
    const sendMessage = vi.fn(async () => '42');
    const connector = new TelegramConnector(
      {
        bot_token: '123456:SAFE_TOKEN',
        enable_polling: true,
      },
      {
        client: { getUpdates: vi.fn(async () => []), sendMessage },
      }
    );

    const result = await connector.sendMessage({
      threadId: 'telegram:private:123456789',
      text: 'plain response',
      blocks: [{ ignored: true }],
    });

    expect(result).toBe('42');
    expect(sendMessage).toHaveBeenCalledWith({
      botToken: '123456:SAFE_TOKEN',
      chatId: '123456789',
      text: 'plain response',
    });
  });

  it('downloads attachments through getFile plus file download without exposing provider URLs', async () => {
    const getFile = vi.fn(async () => ({
      fileId: 'telegram-file-id',
      filePath: 'documents/file.pdf',
      fileSize: 4,
    }));
    const downloadFile = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
    const connector = new TelegramConnector(
      { bot_token: '123456:SAFE_TOKEN' },
      { client: { getUpdates: vi.fn(async () => []), getFile, downloadFile } }
    );

    await expect(
      connector.downloadAttachment({
        maxBytes: 10,
        attachment: {
          id: 'telegram-file-id',
          kind: 'file',
          filename: '../unsafe.pdf',
          mimeType: 'application/pdf',
          metadata: { telegram_file_id: 'telegram-file-id' },
        },
      })
    ).resolves.toEqual({
      bytes: new Uint8Array([1, 2, 3, 4]),
      filename: 'unsafe.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
    });
    expect(getFile).toHaveBeenCalledWith({
      botToken: '123456:SAFE_TOKEN',
      fileId: 'telegram-file-id',
    });
    expect(downloadFile).toHaveBeenCalledWith({
      botToken: '123456:SAFE_TOKEN',
      filePath: 'documents/file.pdf',
      maxBytes: 10,
    });
  });

  it('fails closed for oversized attachment metadata before downloading bytes', async () => {
    const getFile = vi.fn();
    const downloadFile = vi.fn();
    const connector = new TelegramConnector(
      { bot_token: '123456:SAFE_TOKEN' },
      { client: { getUpdates: vi.fn(async () => []), getFile, downloadFile } }
    );

    await expect(
      connector.downloadAttachment({
        maxBytes: 10,
        attachment: {
          id: 'telegram-file-id',
          kind: 'file',
          filename: 'big.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 11,
          metadata: { telegram_file_id: 'telegram-file-id' },
        },
      })
    ).rejects.toThrow('size limit');
    expect(getFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('redacts Telegram token and file id from download errors', async () => {
    const connector = new TelegramConnector(
      { bot_token: '123456:SAFE_TOKEN' },
      {
        client: {
          getUpdates: vi.fn(async () => []),
          getFile: vi.fn(async () => {
            throw new Error(
              'failed https://api.telegram.org/bot123456:SAFE_TOKEN/getFile?file_id=secret-file-id'
            );
          }),
          downloadFile: vi.fn(),
        },
      }
    );

    await expect(
      connector.downloadAttachment({
        maxBytes: 10,
        attachment: {
          id: 'secret-file-id',
          kind: 'file',
          filename: 'secret.pdf',
          mimeType: 'application/pdf',
          metadata: { telegram_file_id: 'secret-file-id' },
        },
      })
    ).rejects.toThrow(/redacted-telegram-token/);
    await expect(
      connector.downloadAttachment({
        maxBytes: 10,
        attachment: {
          id: 'secret-file-id',
          kind: 'file',
          filename: 'secret.pdf',
          mimeType: 'application/pdf',
          metadata: { telegram_file_id: 'secret-file-id' },
        },
      })
    ).rejects.not.toThrow(/SAFE_TOKEN|secret-file-id/);
  });

  it('redacts Telegram file paths and download URLs from download errors', async () => {
    const fileId = 'secret-file-id';
    const filePath = 'documents/raw-secret-file-path.pdf';
    const downloadUrl = `https://api.telegram.org/file/bot123456:SAFE_TOKEN/${filePath}`;
    const connector = new TelegramConnector(
      { bot_token: '123456:SAFE_TOKEN' },
      {
        client: {
          getUpdates: vi.fn(async () => []),
          getFile: vi.fn(async () => ({
            fileId,
            filePath,
            fileSize: 4,
          })),
          downloadFile: vi.fn(async () => {
            throw new Error(
              `failed ${downloadUrl} for path ${filePath} and id ${fileId} with token 123456:SAFE_TOKEN`
            );
          }),
        },
      }
    );

    let thrown: Error | undefined;
    try {
      await connector.downloadAttachment({
        maxBytes: 10,
        attachment: {
          id: fileId,
          kind: 'file',
          filename: 'secret.pdf',
          mimeType: 'application/pdf',
          metadata: { telegram_file_id: fileId },
        },
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    expect(thrown?.message).toContain('[redacted-telegram-file-url]');
    expect(thrown?.message).not.toContain('123456:SAFE_TOKEN');
    expect(thrown?.message).not.toContain(fileId);
    expect(thrown?.message).not.toContain(filePath);
    expect(thrown?.message).not.toContain(downloadUrl);
  });

  it('formats rich markdown as Telegram HTML with escaped untrusted text', async () => {
    const input = [
      '**Bold** and _italic_ with [docs](https://agor.live)',
      'Inline `a < b && c`',
      '- list-like item <safe>',
      '',
      '```ts',
      'const tag = "<script>";',
      '```',
    ].join('\n');

    const html = markdownToTelegramHtml(input);

    expect(html).toContain('<b>Bold</b>');
    expect(html).toContain('<i>italic</i>');
    expect(html).toContain('<a href="https://agor.live">docs</a>');
    expect(html).toContain('<code>a &lt; b &amp;&amp; c</code>');
    expect(html).toContain('- list-like item &lt;safe&gt;');
    expect(html).toContain(
      '<pre><code class="language-ts">const tag = &quot;&lt;script&gt;&quot;;</code></pre>'
    );
    expect(html).not.toContain('<script>');
  });

  it('sends formatted Telegram HTML with parse mode for connector-formatted messages', async () => {
    const sendMessage = vi.fn(async () => '42');
    const connector = new TelegramConnector(
      { bot_token: '123456:SAFE_TOKEN' },
      { client: { getUpdates: vi.fn(async () => []), sendMessage } }
    );
    const payload = connector.formatMessage('**Bold** [link](https://agor.live) `code`');

    await expect(
      connector.sendMessage({
        threadId: 'telegram:private:123456789',
        text: payload.text,
        blocks: payload.blocks,
      })
    ).resolves.toBe('42');

    expect(sendMessage).toHaveBeenCalledWith({
      botToken: '123456:SAFE_TOKEN',
      chatId: '123456789',
      text: '<b>Bold</b> <a href="https://agor.live">link</a> <code>code</code>',
      parseMode: 'HTML',
    });
  });

  it('retries once as plain text when Telegram rejects rich formatting', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockResolvedValueOnce('fallback-42');
    const connector = new TelegramConnector(
      { bot_token: '123456:SAFE_TOKEN' },
      { client: { getUpdates: vi.fn(async () => []), sendMessage } }
    );
    const payload = connector.formatMessage('**Bold** unsafe');

    await expect(
      connector.sendMessage({
        threadId: 'telegram:private:123456789',
        text: payload.text,
        blocks: payload.blocks,
      })
    ).resolves.toBe('fallback-42');

    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      botToken: '123456:SAFE_TOKEN',
      chatId: '123456789',
      text: '<b>Bold</b> unsafe',
      parseMode: 'HTML',
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      botToken: '123456:SAFE_TOKEN',
      chatId: '123456789',
      text: '**Bold** unsafe',
    });
  });

  it('splits long Telegram replies into bounded chunks before sending', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second')
      .mockResolvedValueOnce('third');
    const connector = new TelegramConnector(
      { bot_token: '123456:SAFE_TOKEN' },
      { client: { getUpdates: vi.fn(async () => []), sendMessage } }
    );
    const longMarkdown = `${'&'.repeat(2_000)}\n${'x'.repeat(4_200)}`;
    const payload = connector.formatMessage(longMarkdown);

    await expect(
      connector.sendMessage({
        threadId: 'telegram:private:123456789',
        text: payload.text,
        blocks: payload.blocks,
      })
    ).resolves.toBe('first');

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendMessage.mock.calls) {
      const req = call[0];
      expect(req.chatId).toBe('123456789');
      expect(req.text.length).toBeLessThanOrEqual(4096);
    }
  });

  it('rejects invalid/non-private/non-numeric thread IDs before sending', async () => {
    const sendMessage = vi.fn(async () => '42');
    const connector = new TelegramConnector(
      { bot_token: '123456:SAFE_TOKEN' },
      { client: { getUpdates: vi.fn(async () => []), sendMessage } }
    );

    await expect(
      connector.sendMessage({ threadId: 'telegram:group:123456789', text: 'hello' })
    ).rejects.toThrow('Invalid Telegram private DM thread ID');
    await expect(
      connector.sendMessage({ threadId: 'telegram:private:abc', text: 'hello' })
    ).rejects.toThrow('Invalid Telegram private DM thread ID');
    await expect(
      connector.sendMessage({ threadId: 'telegram:private:0', text: 'hello' })
    ).rejects.toThrow('Invalid Telegram private DM thread ID');

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('fails closed without sending when bot_token is missing or transport is disabled', async () => {
    const sendMessage = vi.fn(async () => '42');

    const tokenless = new TelegramConnector(
      {},
      { client: { getUpdates: vi.fn(async () => []), sendMessage } }
    );
    await expect(
      tokenless.sendMessage({ threadId: 'telegram:private:123456789', text: 'hello' })
    ).rejects.toThrow('Telegram connector requires bot_token to send messages');

    const killSwitched = new TelegramConnector(
      { bot_token: '123456:SAFE_TOKEN', transport_disabled: true },
      { client: { getUpdates: vi.fn(async () => []), sendMessage } }
    );
    await expect(
      killSwitched.sendMessage({ threadId: 'telegram:private:123456789', text: 'hello' })
    ).rejects.toThrow('Telegram transport is disabled');

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('redacts bot tokens and message text from outbound errors', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error(
        'provider failed at https://api.telegram.org/bot123456:SECRET_TOKEN/sendMessage for message: hello secret'
      );
    });
    const connector = new TelegramConnector(
      { bot_token: '123456:SECRET_TOKEN' },
      { client: { getUpdates: vi.fn(async () => []), sendMessage } }
    );

    await expect(
      connector.sendMessage({
        threadId: 'telegram:private:123456789',
        text: 'hello secret',
      })
    ).rejects.toThrow(/Telegram sendMessage failed/);

    try {
      await connector.sendMessage({
        threadId: 'telegram:private:123456789',
        text: 'hello secret',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('123456:SECRET_TOKEN');
      expect(message).not.toContain('hello secret');
      expect(message).toContain('[redacted-telegram-token]');
      expect(message).toContain('[redacted-message]');
    }
  });
});
