/**
 * Telegram inbound normalization helpers.
 *
 * This file intentionally does not implement webhooks, attachment downloads,
 * groups, channels, Mini Apps, or provider mutation.
 * It is the adapter-edge boundary for converting one raw Telegram Bot API
 * update into Agor's provider-agnostic InboundMessage shape and, when explicitly
 * enabled, polling Telegram getUpdates without changing remote provider state.
 */

import type { ChannelType } from '../../types/gateway';
import type { GatewayConnector, InboundMessage, OutboundPayload } from '../connector';

export const TELEGRAM_EXTERNAL_IDENTITY_PROVIDER = 'telegram';
export const TELEGRAM_EXTERNAL_IDENTITY_ISSUER = 'telegram';

const TELEGRAM_LINK_COMMAND = 'link';
const TELEGRAM_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const TELEGRAM_HTML_PARSE_MODE = 'HTML';
const TELEGRAM_MESSAGE_MAX_CHARS = 4096;
const TELEGRAM_RICH_BLOCK_TYPE = 'telegram_html';

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

export type TelegramTransportRejectionReason = TelegramInboundRejectionReason | 'rate_limited';

export interface TelegramTransportSuccess {
  ok: true;
  message: InboundMessage;
}

export interface TelegramTransportFailure {
  ok: false;
  reason: TelegramTransportRejectionReason;
}

export type TelegramTransportResult = TelegramTransportSuccess | TelegramTransportFailure;

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

export interface TelegramConfig {
  bot_token?: string;
  enable_polling?: boolean;
  transport_disabled?: boolean;
  poll_interval_ms?: number;
  poll_timeout_seconds?: number;
}

export interface TelegramGetUpdatesRequest {
  botToken: string;
  offset?: number;
  timeoutSeconds?: number;
}

export interface TelegramSendMessageRequest {
  botToken: string;
  chatId: string;
  text: string;
  parseMode?: 'HTML';
}

export interface TelegramUpdateClient {
  getUpdates(req: TelegramGetUpdatesRequest): Promise<unknown[]>;
  sendMessage?(req: TelegramSendMessageRequest): Promise<string>;
}

interface TelegramHtmlOutboundBlock {
  type: typeof TELEGRAM_RICH_BLOCK_TYPE;
  parse_mode: typeof TELEGRAM_HTML_PARSE_MODE;
  text: string;
  source: string;
}

export interface TelegramConnectorOptions {
  client?: TelegramUpdateClient;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  rateLimit?: (message: InboundMessage) => boolean;
  now?: () => Date;
}

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
 * `/link <token>` describes a safe Agor-side link-token verification intent.
 * It does not trust usernames, create users, or create sessions.
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

function getUpdateId(update: unknown): number | undefined {
  if (!isRecord(update)) return undefined;
  const updateId = update.update_id;
  return typeof updateId === 'number' && Number.isSafeInteger(updateId) && updateId >= 0
    ? updateId
    : undefined;
}

function isValidBotToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function pollingIntervalMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1000 ? value : 10_000;
}

function pollingTimeoutSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), 50)
    : undefined;
}

export function parseTelegramPrivateThreadId(threadId: string): string {
  const match = /^telegram:private:([1-9]\d*)$/.exec(threadId);
  if (!match) {
    throw new Error('Invalid Telegram private DM thread ID');
  }
  return match[1];
}

function sanitizeTelegramError(
  error: unknown,
  botToken?: string,
  sensitiveTexts: ReadonlyArray<string | undefined> = []
): string {
  const raw = error instanceof Error ? error.message : String(error);
  let sanitized = raw.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted-telegram-token]');
  sanitized = sanitized.replace(/\b\d{5,}:[A-Za-z0-9_-]{10,}\b/g, '[redacted-telegram-token]');
  if (botToken) {
    sanitized = sanitized.split(botToken).join('[redacted-telegram-token]');
  }
  for (const text of sensitiveTexts) {
    if (text) {
      sanitized = sanitized.split(text).join('[redacted-message]');
    }
  }
  return sanitized;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isSafeTelegramLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function findClosingMarkdownParen(value: string, start: number): number {
  for (let i = start; i < value.length; i++) {
    if (value[i] === '\\') {
      i++;
      continue;
    }
    if (value[i] === ')') return i;
  }
  return -1;
}

function parseTelegramInlineMarkdown(value: string): string {
  let out = '';
  let index = 0;

  while (index < value.length) {
    if (value[index] === '`') {
      const end = value.indexOf('`', index + 1);
      if (end > index + 1) {
        out += `<code>${htmlEscape(value.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }

    if (value.startsWith('[', index)) {
      const labelEnd = value.indexOf(']', index + 1);
      if (labelEnd > index + 1 && value[labelEnd + 1] === '(') {
        const urlEnd = findClosingMarkdownParen(value, labelEnd + 2);
        if (urlEnd > labelEnd + 2) {
          const label = value.slice(index + 1, labelEnd);
          const url = value.slice(labelEnd + 2, urlEnd).trim();
          if (isSafeTelegramLink(url)) {
            out += `<a href="${htmlEscape(url)}">${parseTelegramInlineMarkdown(label)}</a>`;
            index = urlEnd + 1;
            continue;
          }
        }
      }
    }

    const twoCharMarker = value.slice(index, index + 2);
    if (twoCharMarker === '**' || twoCharMarker === '__') {
      const end = value.indexOf(twoCharMarker, index + 2);
      if (end > index + 2) {
        out += `<b>${parseTelegramInlineMarkdown(value.slice(index + 2, end))}</b>`;
        index = end + 2;
        continue;
      }
    }

    const oneCharMarker = value[index];
    if (oneCharMarker === '*' || oneCharMarker === '_') {
      const end = value.indexOf(oneCharMarker, index + 1);
      if (end > index + 1) {
        out += `<i>${parseTelegramInlineMarkdown(value.slice(index + 1, end))}</i>`;
        index = end + 1;
        continue;
      }
    }

    out += htmlEscape(value[index]);
    index++;
  }

  return out;
}

function normalizeTelegramCodeLanguage(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^[A-Za-z0-9_+-]{1,32}$/.test(trimmed)) return null;
  return trimmed;
}

export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceLanguage: string | null = null;
  let codeLines: string[] = [];

  const flushCode = (): void => {
    const code = htmlEscape(codeLines.join('\n'));
    out.push(
      fenceLanguage
        ? `<pre><code class="language-${htmlEscape(fenceLanguage)}">${code}</code></pre>`
        : `<pre>${code}</pre>`
    );
    codeLines = [];
    fenceLanguage = null;
  };

  for (const line of lines) {
    const fenceMatch = /^```\s*([A-Za-z0-9_+-]{0,32})\s*$/.exec(line);
    if (fenceMatch) {
      if (inFence) {
        flushCode();
        inFence = false;
      } else {
        inFence = true;
        fenceLanguage = normalizeTelegramCodeLanguage(fenceMatch[1]);
      }
      continue;
    }

    if (inFence) {
      codeLines.push(line);
      continue;
    }

    out.push(parseTelegramInlineMarkdown(line));
  }

  if (inFence) {
    flushCode();
  }

  return out.join('\n');
}

function telegramHtmlBlockFromMarkdown(markdown: string): TelegramHtmlOutboundBlock {
  return {
    type: TELEGRAM_RICH_BLOCK_TYPE,
    parse_mode: TELEGRAM_HTML_PARSE_MODE,
    text: markdownToTelegramHtml(markdown),
    source: markdown,
  };
}

function extractTelegramHtmlBlock(blocks?: unknown[]): TelegramHtmlOutboundBlock | null {
  if (!blocks) return null;
  const block = blocks.find((candidate) => {
    if (!isRecord(candidate)) return false;
    return (
      candidate.type === TELEGRAM_RICH_BLOCK_TYPE &&
      candidate.parse_mode === TELEGRAM_HTML_PARSE_MODE &&
      typeof candidate.text === 'string' &&
      typeof candidate.source === 'string'
    );
  });
  return (block as TelegramHtmlOutboundBlock | undefined) ?? null;
}

function splitAtNaturalBoundary(value: string, maxChars: number): [string, string] {
  if (value.length <= maxChars) return [value, ''];
  const window = value.slice(0, maxChars + 1);
  const newlineAt = window.lastIndexOf('\n');
  const spaceAt = window.lastIndexOf(' ');
  const splitAt = Math.max(newlineAt, spaceAt);
  const index = splitAt > 0 ? splitAt + (window[splitAt] === '\n' ? 1 : 0) : maxChars;
  return [value.slice(0, index), value.slice(index)];
}

function splitTelegramText(
  value: string,
  render: (chunk: string) => string = (chunk) => chunk
): string[] {
  if (value.length === 0) return [''];

  const chunks: string[] = [];
  const queue = [value];

  while (queue.length > 0) {
    const current = queue.shift() ?? '';
    if (
      current.length <= TELEGRAM_MESSAGE_MAX_CHARS &&
      render(current).length <= TELEGRAM_MESSAGE_MAX_CHARS
    ) {
      chunks.push(current);
      continue;
    }

    const [head, tail] = splitAtNaturalBoundary(
      current,
      Math.max(1, Math.min(TELEGRAM_MESSAGE_MAX_CHARS, Math.floor(current.length / 2)))
    );
    if (!head || head === current) {
      chunks.push(current.slice(0, TELEGRAM_MESSAGE_MAX_CHARS));
      const rest = current.slice(TELEGRAM_MESSAGE_MAX_CHARS);
      if (rest) queue.unshift(rest);
      continue;
    }

    queue.unshift(...(tail ? [head, tail] : [head]));
  }

  return chunks;
}

function isTelegramRichFormatError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:can't|cannot|could not)\s+parse|parse entities|unsupported start tag|can't find end tag|entity/i.test(
    message
  );
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

  const updateId = getUpdateId(update);
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
        ...(typeof updateId === 'number' ? { telegram_update_id: updateId } : {}),
        ...(messageId ? { telegram_message_id: messageId } : {}),
        ...(typeof from?.username === 'string' ? { telegram_username: from.username } : {}),
        ...(typeof from?.first_name === 'string' ? { telegram_first_name: from.first_name } : {}),
        ...(typeof from?.last_name === 'string' ? { telegram_last_name: from.last_name } : {}),
      },
    },
  };
}

/**
 * Testable transport bridge from a raw Telegram update into the gateway inbound
 * callback. This owns only Telegram edge-shape normalization, non-secret audit
 * metadata, and an optional rate-limit seam; user auth remains in GatewayService.
 */
export function handleTelegramUpdate(
  update: unknown,
  callback: (msg: InboundMessage) => void,
  opts: {
    transport?: 'polling' | 'webhook' | 'test';
    rateLimit?: (message: InboundMessage) => boolean;
    now?: () => Date;
  } = {}
): TelegramTransportResult {
  const normalized = normalizeTelegramInboundUpdate(update);
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason };
  }

  const auditMetadata: Record<string, unknown> = {
    ...(normalized.message.metadata ?? {}),
    telegram_transport: opts.transport ?? 'test',
    telegram_received_at: (opts.now ?? (() => new Date()))().toISOString(),
  };
  const message = {
    ...normalized.message,
    metadata: auditMetadata,
  };

  if (opts.rateLimit && !opts.rateLimit(message)) {
    return { ok: false, reason: 'rate_limited' };
  }

  callback(message);
  return { ok: true, message };
}

class FetchTelegramUpdateClient implements TelegramUpdateClient {
  async getUpdates(req: TelegramGetUpdatesRequest): Promise<unknown[]> {
    const url = new URL(`https://api.telegram.org/bot${req.botToken}/getUpdates`);
    if (typeof req.offset === 'number') {
      url.searchParams.set('offset', String(req.offset));
    }
    if (typeof req.timeoutSeconds === 'number') {
      url.searchParams.set('timeout', String(req.timeoutSeconds));
    }
    // Keep the default fetch dependency inside the polling-only path so tests
    // and disabled channels never touch the network.
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed with HTTP ${response.status}`);
    }
    const body = await response.json();
    if (!isRecord(body) || body.ok !== true || !Array.isArray(body.result)) {
      throw new Error('Telegram getUpdates returned an unexpected response shape');
    }
    return body.result;
  }

  async sendMessage(req: TelegramSendMessageRequest): Promise<string> {
    const response = await fetch(`https://api.telegram.org/bot${req.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: req.chatId,
        text: req.text,
        ...(req.parseMode ? { parse_mode: req.parseMode } : {}),
      }),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const description =
        isRecord(body) && typeof body.description === 'string' ? `: ${body.description}` : '';
      throw new Error(`Telegram sendMessage failed with HTTP ${response.status}${description}`);
    }
    if (!isRecord(body) || body.ok !== true || !isRecord(body.result)) {
      const description =
        isRecord(body) && typeof body.description === 'string' ? `: ${body.description}` : '';
      throw new Error(`Telegram sendMessage returned an unexpected response shape${description}`);
    }
    const messageId = body.result.message_id;
    if (typeof messageId !== 'number' && typeof messageId !== 'string') {
      throw new Error('Telegram sendMessage response is missing message_id');
    }
    return String(messageId);
  }
}

export class TelegramConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'telegram';

  private readonly config: TelegramConfig;
  private readonly client: TelegramUpdateClient;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly rateLimit?: (message: InboundMessage) => boolean;
  private readonly now?: () => Date;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private nextOffset: number | undefined;

  constructor(config: Record<string, unknown>, options: TelegramConnectorOptions = {}) {
    this.config = config as TelegramConfig;
    this.client = options.client ?? new FetchTelegramUpdateClient();
    this.setIntervalFn = options.setInterval ?? setInterval;
    this.clearIntervalFn = options.clearInterval ?? clearInterval;
    this.rateLimit = options.rateLimit;
    this.now = options.now;
  }

  /**
   * Send a reply to a private Telegram DM thread.
   *
   * Rich markdown is carried as an opaque Telegram HTML block produced by
   * {@link formatMessage}. If Telegram rejects that HTML/parse payload, the
   * connector retries the same chunk once as plain text so formatting quirks
   * never drop the response. Attachments, groups/channels, proactive emits,
   * and provider setup remain out of scope.
   */
  async sendMessage(req: {
    threadId: string;
    text: string;
    blocks?: unknown[];
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    if (this.config.transport_disabled === true) {
      throw new Error('Telegram transport is disabled');
    }
    if (!isValidBotToken(this.config.bot_token)) {
      throw new Error('Telegram connector requires bot_token to send messages');
    }
    if (!this.client.sendMessage) {
      throw new Error('Telegram connector client does not support sendMessage');
    }

    const chatId = parseTelegramPrivateThreadId(req.threadId);
    const richBlock = extractTelegramHtmlBlock(req.blocks);
    const chunks = richBlock
      ? splitTelegramText(richBlock.source, markdownToTelegramHtml)
      : splitTelegramText(req.text);
    let firstMessageId: string | undefined;

    for (const chunk of chunks) {
      const richText = richBlock ? markdownToTelegramHtml(chunk) : undefined;
      const sensitiveTexts = [req.text, chunk, richText, richBlock?.text];

      try {
        const messageId = await this.client.sendMessage({
          botToken: this.config.bot_token,
          chatId,
          text: richText ?? chunk,
          ...(richText ? { parseMode: TELEGRAM_HTML_PARSE_MODE } : {}),
        });
        firstMessageId ??= messageId;
      } catch (error) {
        if (richText && isTelegramRichFormatError(error)) {
          try {
            const fallbackMessageId = await this.client.sendMessage({
              botToken: this.config.bot_token,
              chatId,
              text: chunk,
            });
            firstMessageId ??= fallbackMessageId;
            continue;
          } catch (fallbackError) {
            throw new Error(
              `Telegram sendMessage failed: ${sanitizeTelegramError(fallbackError, this.config.bot_token, sensitiveTexts)}`
            );
          }
        }

        throw new Error(
          `Telegram sendMessage failed: ${sanitizeTelegramError(error, this.config.bot_token, sensitiveTexts)}`
        );
      }
    }

    return firstMessageId ?? '';
  }

  formatMessage(markdown: string): OutboundPayload {
    return {
      text: markdown,
      blocks: [telegramHtmlBlockFromMarkdown(markdown)],
    };
  }

  async startListening(callback: (msg: InboundMessage) => void): Promise<void> {
    if (this.config.transport_disabled === true) {
      console.log('[telegram] Polling disabled by transport kill switch');
      return;
    }
    if (this.config.enable_polling !== true) {
      console.log('[telegram] Polling not enabled; listener not started');
      return;
    }
    if (!isValidBotToken(this.config.bot_token)) {
      throw new Error('Telegram connector requires bot_token to start polling');
    }
    if (this.pollTimer) {
      return;
    }

    const intervalMs = pollingIntervalMs(this.config.poll_interval_ms);
    this.pollTimer = this.setIntervalFn(() => {
      void this.pollOnce(callback);
    }, intervalMs);
    console.log(`[telegram] Polling listener started (interval: ${intervalMs}ms)`);
  }

  async pollOnce(callback: (msg: InboundMessage) => void): Promise<void> {
    if (this.polling) {
      console.warn('[telegram] Poll tick skipped (previous tick still running)');
      return;
    }
    if (this.config.transport_disabled === true || this.config.enable_polling !== true) {
      return;
    }
    if (!isValidBotToken(this.config.bot_token)) {
      throw new Error('Telegram connector requires bot_token to poll updates');
    }

    this.polling = true;
    try {
      const timeoutSeconds = pollingTimeoutSeconds(this.config.poll_timeout_seconds);
      const updates = await this.client.getUpdates({
        botToken: this.config.bot_token,
        ...(typeof this.nextOffset === 'number' ? { offset: this.nextOffset } : {}),
        ...(typeof timeoutSeconds === 'number' ? { timeoutSeconds } : {}),
      });

      for (const update of updates) {
        handleTelegramUpdate(update, callback, {
          transport: 'polling',
          rateLimit: this.rateLimit,
          now: this.now,
        });
        const updateId = getUpdateId(update);
        if (typeof updateId === 'number') {
          this.nextOffset = updateId + 1;
        }
      }
    } catch (error) {
      console.warn(
        '[telegram] Poll tick failed:',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      this.polling = false;
    }
  }

  async stopListening(): Promise<void> {
    if (this.pollTimer) {
      this.clearIntervalFn(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
    console.log('[telegram] Polling listener stopped');
  }
}
