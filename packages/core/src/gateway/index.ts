/**
 * Gateway connector layer
 *
 * Platform-specific connectors for sending/receiving messages
 * through messaging platforms (Slack, Discord, etc.)
 */

export type { GatewayConnector, InboundMessage, OutboundPayload } from './connector';
export { normalizeOutbound } from './connector';
export { getConnector, hasConnector, registerConnector } from './connector-registry';
export { GitHubConnector, parseThreadId as parseGitHubThreadId } from './connectors/github';
export type {
  SlackThreadHistoryMessage,
  SlackThreadHistoryRequest,
  SlackThreadHistoryResult,
} from './connectors/slack';
export {
  isChannelAllowedByWhitelist,
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
} from './connectors/slack-manifest';
export {
  extractQuotedReplyText,
  parseThreadId as parseTeamsThreadId,
  TeamsConnector,
} from './connectors/teams';
export type {
  TelegramInboundNormalizationResult,
  TelegramInboundRejectionReason,
} from './connectors/telegram';
export {
  normalizeTelegramInboundUpdate,
  TELEGRAM_EXTERNAL_IDENTITY_ISSUER,
  TELEGRAM_EXTERNAL_IDENTITY_PROVIDER,
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
