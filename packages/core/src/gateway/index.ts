/**
 * Gateway connector layer
 *
 * Platform-specific connectors for sending/receiving messages
 * through messaging platforms (Slack, Discord, etc.)
 */

export type {
  GatewayConnector,
  InboundAttachment,
  InboundAttachmentRejection,
  InboundFile,
  InboundMessage,
  OutboundPayload,
} from './connector';
export { normalizeOutbound } from './connector';
export { getConnector, hasConnector, registerConnector } from './connector-registry';
export { GitHubConnector, parseThreadId as parseGitHubThreadId } from './connectors/github';
export type {
  SlackChannelHistoryRequest,
  SlackChannelHistoryResult,
  SlackThreadHistoryMessage,
  SlackThreadHistoryRequest,
  SlackThreadHistoryResult,
} from './connectors/slack';
export {
  extractSlackInboundFiles,
  isChannelAllowedByWhitelist,
  isSlackDirectMessageId,
  isSlackWriteTargetAllowed,
  markdownToMrkdwn,
  SlackConnector,
} from './connectors/slack';
export type {
  SlackAppManifest,
  SlackBotEventSubscriptions,
  SlackWizardOptions,
} from './connectors/slack-manifest';
export {
  buildSlackManifest,
  requiredBotEvents,
  requiredBotScopes,
  SLACK_AGENT_TOOL_SCOPES,
} from './connectors/slack-manifest';
export {
  extractQuotedReplyText,
  parseThreadId as parseTeamsThreadId,
  TeamsConnector,
} from './connectors/teams';
export type {
  TelegramCommandIntent,
  TelegramConfig,
  TelegramConnectorOptions,
  TelegramDownloadFileRequest,
  TelegramFileInfo,
  TelegramGetFileRequest,
  TelegramGetUpdatesRequest,
  TelegramInboundNormalizationResult,
  TelegramInboundRejectionReason,
  TelegramTransportFailure,
  TelegramTransportRejectionReason,
  TelegramTransportResult,
  TelegramTransportSuccess,
  TelegramUpdateClient,
} from './connectors/telegram';
export {
  handleTelegramUpdate,
  normalizeTelegramInboundUpdate,
  parseTelegramCommandIntent,
  parseTelegramPrivateThreadId,
  TELEGRAM_EXTERNAL_IDENTITY_ISSUER,
  TELEGRAM_EXTERNAL_IDENTITY_PROVIDER,
  TelegramConnector,
  telegramExternalIdentityRef,
} from './connectors/telegram';
export type { GatewayContext } from './context';
export { formatGatewayContext } from './context';
export {
  formatGatewayFollowUpRoutingMessage,
  formatGatewayMarkdownSessionReference,
  formatGatewaySessionCreatedMessage,
  formatGatewaySystemMessage,
  formatGatewaySystemPayload,
} from './system-message';
