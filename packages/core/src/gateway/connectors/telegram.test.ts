import { describe, expect, it } from 'vitest';
import { normalizeTelegramInboundUpdate } from './telegram';

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
