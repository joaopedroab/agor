/**
 * Telegram inbound normalization helpers.
 *
 * This file intentionally does not implement polling, webhooks, outbound
 * sends, attachment downloads, groups, channels, or Mini Apps. It is the
 * adapter-edge boundary for converting one raw Telegram Bot API update into
 * Agor's provider-agnostic InboundMessage shape once a future transport has
 * already authenticated and delivered the raw update.
 */

import type { InboundMessage } from '../connector';

export const TELEGRAM_EXTERNAL_IDENTITY_PROVIDER = 'telegram';
export const TELEGRAM_EXTERNAL_IDENTITY_ISSUER = 'telegram';

const TELEGRAM_LINK_COMMAND = 'link';
const TELEGRAM_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;

const UNSUPPORTED_MESSAGE_FIELDS = [
  'audio',
  'document',
  'animation',
  'game',
  'photo',
  'sticker',
  'video',
  'video_note',
  'voice',
  'caption',
  'contact',
  'dice',
  'location',
  'venue',
  'poll',
  'web_app_data',
  'new_chat_members',
  'left_chat_member',
  'new_chat_title',
  'new_chat_photo',
  'delete_chat_photo',
  'group_chat_created',
  'supergroup_chat_created',
  'channel_chat_created',
  'message_auto_delete_timer_changed',
  'migrate_to_chat_id',
  'migrate_from_chat_id',
  'pinned_message',
  'invoice',
  'successful_payment',
  'passport_data',
  'proximity_alert_triggered',
  'forum_topic_created',
  'forum_topic_edited',
  'forum_topic_closed',
  'forum_topic_reopened',
  'video_chat_scheduled',
  'video_chat_started',
  'video_chat_ended',
  'video_chat_participants_invited',
  'write_access_allowed',
  'users_shared',
  'chat_shared',
  'story',
  'external_reply',
  'quote',
  'reply_to_story',
] as const;

export type TelegramInboundRejectionReason =
  | 'unsupported_update_shape'
  | 'unsupported_chat_type'
  | 'missing_sender_id'
  | 'bot_sender'
  | 'unsupported_message_content'
  | 'empty_text';

export interface TelegramInboundNormalizationSuccess {
  ok: true;
  message: InboundMessage;
}

export interface TelegramInboundNormalizationFailure {
  ok: false;
  reason: TelegramInboundRejectionReason;
}

export type TelegramInboundNormalizationResult =
  | TelegramInboundNormalizationSuccess
  | TelegramInboundNormalizationFailure;

export type TelegramAuthRejectionReason =
  | 'missing_numeric_sender_id'
  | 'unlinked_user'
  | 'ambiguous_link';

export interface TelegramLinkedUserCandidate {
  user_id: string;
}

export interface TelegramInboundAuthSuccess {
  ok: true;
  telegramUserId: string;
  agorUserId: string;
}

export interface TelegramInboundAuthFailure {
  ok: false;
  reason: TelegramAuthRejectionReason;
  telegramUserId?: string;
}

export type TelegramInboundAuthDecision = TelegramInboundAuthSuccess | TelegramInboundAuthFailure;

export type TelegramCommandIntent =
  | { kind: 'regular_message' }
  | { kind: 'link_help' }
  | { kind: 'link_token'; token: string; telegramUserId: string }
  | { kind: 'invalid_link_token'; reason: 'missing_numeric_sender_id' | 'invalid_token' }
  | { kind: 'unsupported_command'; command: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numericTelegramId(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return null;
    }
    return String(value);
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    return value;
  }
  return null;
}

function rawNumericTelegramId(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return String(value);
}

export function normalizeTelegramExternalSubject(value: unknown): string | null {
  return numericTelegramId(value);
}

export function telegramExternalIdentityRef(telegramUserId: unknown): {
  provider: typeof TELEGRAM_EXTERNAL_IDENTITY_PROVIDER;
  issuer: typeof TELEGRAM_EXTERNAL_IDENTITY_ISSUER;
  subject: string;
} | null {
  const subject = normalizeTelegramExternalSubject(telegramUserId);
  if (!subject) return null;
  return {
    provider: TELEGRAM_EXTERNAL_IDENTITY_PROVIDER,
    issuer: TELEGRAM_EXTERNAL_IDENTITY_ISSUER,
    subject,
  };
}

/**
 * Decide whether a normalized Telegram sender is allowed to act as an Agor user.
 *
 * This is intentionally pure: callers provide already-looked-up explicit links
 * and the decision fails closed for missing, unlinked, or duplicate/ambiguous
 * links. Usernames never participate in this decision.
 */
export function decideTelegramInboundAuth(input: {
  telegramUserId: unknown;
  linkedUsers: ReadonlyArray<TelegramLinkedUserCandidate>;
}): TelegramInboundAuthDecision {
  const telegramUserId = normalizeTelegramExternalSubject(input.telegramUserId);
  if (!telegramUserId) {
    return { ok: false, reason: 'missing_numeric_sender_id' };
  }

  const uniqueUserIds = Array.from(
    new Set(input.linkedUsers.map((candidate) => candidate.user_id).filter(Boolean))
  );
  if (uniqueUserIds.length === 0) {
    return { ok: false, reason: 'unlinked_user', telegramUserId };
  }
  if (uniqueUserIds.length > 1) {
    return { ok: false, reason: 'ambiguous_link', telegramUserId };
  }

  return { ok: true, telegramUserId, agorUserId: uniqueUserIds[0] };
}

/**
 * Parse Telegram text commands without performing any live provider action.
 *
 * `/link <token>` only describes a future safe link-token verification intent.
 * It does not trust usernames, create users, create sessions, or mutate links.
 */
export function parseTelegramCommandIntent(
  text: string,
  telegramUserId?: unknown
): TelegramCommandIntent {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'regular_message' };
  }

  const [rawCommand = '', ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.slice(1).split('@')[0].toLowerCase();
  if (command !== TELEGRAM_LINK_COMMAND) {
    return { kind: 'unsupported_command', command };
  }

  const token = rest.join(' ').trim();
  if (!token) {
    return { kind: 'link_help' };
  }
  if (!TELEGRAM_LINK_TOKEN_PATTERN.test(token)) {
    return { kind: 'invalid_link_token', reason: 'invalid_token' };
  }

  const normalizedTelegramUserId = normalizeTelegramExternalSubject(telegramUserId);
  if (!normalizedTelegramUserId) {
    return { kind: 'invalid_link_token', reason: 'missing_numeric_sender_id' };
  }

  return { kind: 'link_token', token, telegramUserId: normalizedTelegramUserId };
}

function hasUnsupportedMessageContent(message: Record<string, unknown>): boolean {
  return UNSUPPORTED_MESSAGE_FIELDS.some((field) => field in message);
}

/**
 * Normalize one Telegram Bot API update into the gateway inbound message shape.
 *
 * MVP accepts only private, human, text-only DMs. Identity is the stable numeric
 * `message.from.id` only; usernames are preserved as display metadata but never
 * become the external subject.
 */
export function normalizeTelegramInboundUpdate(
  update: unknown
): TelegramInboundNormalizationResult {
  if (!isRecord(update) || !isRecord(update.message)) {
    return { ok: false, reason: 'unsupported_update_shape' };
  }

  const message = update.message;
  const chat = isRecord(message.chat) ? message.chat : null;
  if (chat?.type !== 'private') {
    return { ok: false, reason: 'unsupported_chat_type' };
  }

  const from = isRecord(message.from) ? message.from : null;
  const fromId = rawNumericTelegramId(from?.id);
  if (!fromId) {
    return { ok: false, reason: 'missing_sender_id' };
  }

  if (from?.is_bot === true) {
    return { ok: false, reason: 'bot_sender' };
  }

  if (hasUnsupportedMessageContent(message) || typeof message.text !== 'string') {
    return { ok: false, reason: 'unsupported_message_content' };
  }

  const text = message.text.trim();
  if (!text) {
    return { ok: false, reason: 'empty_text' };
  }

  const messageId =
    typeof message.message_id === 'number' && Number.isSafeInteger(message.message_id)
      ? String(message.message_id)
      : undefined;
  const timestamp =
    typeof message.date === 'number' && Number.isFinite(message.date)
      ? new Date(message.date * 1000).toISOString()
      : new Date(0).toISOString();

  return {
    ok: true,
    message: {
      threadId: `telegram:private:${fromId}`,
      text,
      userId: fromId,
      timestamp,
      metadata: {
        telegram_chat_type: 'private',
        telegram_user_id: fromId,
        telegram_identity_provider: TELEGRAM_EXTERNAL_IDENTITY_PROVIDER,
        telegram_identity_issuer: TELEGRAM_EXTERNAL_IDENTITY_ISSUER,
        telegram_external_subject: fromId,
        ...(messageId ? { telegram_message_id: messageId } : {}),
        ...(typeof from?.username === 'string' ? { telegram_username: from.username } : {}),
        ...(typeof from?.first_name === 'string' ? { telegram_first_name: from.first_name } : {}),
        ...(typeof from?.last_name === 'string' ? { telegram_last_name: from.last_name } : {}),
      },
    },
  };
}
