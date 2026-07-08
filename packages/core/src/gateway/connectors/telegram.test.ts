import { describe, expect, it } from 'vitest';
import {
  decideTelegramInboundAuth,
  normalizeTelegramInboundUpdate,
  parseTelegramCommandIntent,
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

  it.each([
    ['photo', { photo: [{ file_id: 'file' }], caption: 'caption' }],
    ['document', { document: { file_id: 'file' } }],
    ['voice', { voice: { file_id: 'file' } }],
    ['web_app_data', { web_app_data: { data: '{}' } }],
  ])('rejects non-text/attachment-like messages: %s', (_label, extraMessageFields) => {
    const result = normalizeTelegramInboundUpdate({
      message: {
        chat: { type: 'private' },
        from: { id: 123456789, is_bot: false },
        text: 'hello',
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
    expect(parseTelegramCommandIntent('/new please')).toEqual({
      kind: 'unsupported_command',
      command: 'new',
    });
    expect(parseTelegramCommandIntent('regular prompt')).toEqual({ kind: 'regular_message' });
  });
});
