/**
 * Gateway Channel Repository
 *
 * Type-safe CRUD operations for gateway channels with short ID support.
 * Handles encryption/decryption of sensitive platform credentials in the config blob.
 */

import type {
  ChannelType,
  GatewayAgenticConfig,
  GatewayChannel,
  GatewayChannelID,
  GatewayEnvVar,
  UUID,
} from '@agor/core/types';
import {
  GATEWAY_REDACTED_SENTINEL,
  GATEWAY_SENSITIVE_CONFIG_FIELDS,
  getRequiredSecretFields,
  prefixToLikePattern,
} from '@agor/core/types';
import { eq, like } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  lockRowForUpdate,
  runTransactionWithRetry,
  select,
  txAsDb,
  update,
} from '../database-wrapper';
import { decryptApiKey, encryptApiKey } from '../encryption';
import { type GatewayChannelInsert, type GatewayChannelRow, gatewayChannels } from '../schema';
import {
  AmbiguousIdError,
  attachHiddenTenant,
  type BaseRepository,
  EntityNotFoundError,
  RepositoryError,
} from './base';

type TelegramPollingInflightStatus = 'reserved' | 'side_effects_started' | 'side_effects_completed';

interface TelegramPollingInflightUpdate {
  update_id: number;
  status: TelegramPollingInflightStatus;
  updated_at: string;
  lease_token?: string;
}

interface TelegramPollingState {
  last_processed_update_id?: unknown;
  recent_processed_update_ids?: unknown;
  inflight_update?: unknown;
  [key: string]: unknown;
}

export type TelegramPollingUpdateClaimResult =
  | { status: 'acquired'; reclaimed: boolean; leaseToken: string }
  | { status: 'processed' }
  | { status: 'active'; inflightStatus: TelegramPollingInflightStatus; updateId: number }
  | { status: 'side_effects_completed'; leaseToken: string };

const TELEGRAM_RECENT_PROCESSED_UPDATE_LIMIT = 20;

function telegramSafeUpdateId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function telegramPollingState(channel: GatewayChannel): TelegramPollingState {
  const state = channel.config.telegram_polling_state;
  return state && typeof state === 'object' && !Array.isArray(state)
    ? (state as TelegramPollingState)
    : {};
}

function telegramInflightUpdate(
  state: TelegramPollingState
): TelegramPollingInflightUpdate | undefined {
  const inflight = state.inflight_update;
  if (!inflight || typeof inflight !== 'object' || Array.isArray(inflight)) return undefined;
  const updateId = telegramSafeUpdateId((inflight as Record<string, unknown>).update_id);
  const status = (inflight as Record<string, unknown>).status;
  const updatedAt = (inflight as Record<string, unknown>).updated_at;
  const leaseToken = (inflight as Record<string, unknown>).lease_token;
  if (
    updateId === undefined ||
    (status !== 'reserved' &&
      status !== 'side_effects_started' &&
      status !== 'side_effects_completed') ||
    typeof updatedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    update_id: updateId,
    status,
    updated_at: updatedAt,
    ...(typeof leaseToken === 'string' && leaseToken ? { lease_token: leaseToken } : {}),
  };
}

function telegramUpdateWasProcessed(state: TelegramPollingState, updateId: number): boolean {
  const lastProcessed = telegramSafeUpdateId(state.last_processed_update_id);
  const recent = Array.isArray(state.recent_processed_update_ids)
    ? state.recent_processed_update_ids.filter(
        (value): value is number => telegramSafeUpdateId(value) === value
      )
    : [];
  return (lastProcessed !== undefined && updateId <= lastProcessed) || recent.includes(updateId);
}

function telegramLeaseMatches(
  state: TelegramPollingState,
  updateId: number,
  leaseToken: string
): TelegramPollingInflightUpdate | undefined {
  const inflight = telegramInflightUpdate(state);
  return inflight?.update_id === updateId && inflight.lease_token === leaseToken
    ? inflight
    : undefined;
}

function appendTelegramProcessedUpdateId(state: TelegramPollingState, updateId: number): number[] {
  const recent = Array.isArray(state.recent_processed_update_ids)
    ? state.recent_processed_update_ids.filter(
        (value): value is number => telegramSafeUpdateId(value) === value
      )
    : [];
  return [...new Set([...recent, updateId])].slice(-TELEGRAM_RECENT_PROCESSED_UPDATE_LIMIT);
}

/**
 * Encrypt sensitive fields within a config object
 */
function encryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  const encrypted = { ...config };
  for (const field of GATEWAY_SENSITIVE_CONFIG_FIELDS) {
    if (typeof encrypted[field] === 'string' && encrypted[field]) {
      encrypted[field] = encryptApiKey(encrypted[field] as string);
    }
  }
  return encrypted;
}

/**
 * Decrypt sensitive fields within a config object
 */
function decryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  const decrypted = { ...config };
  for (const field of GATEWAY_SENSITIVE_CONFIG_FIELDS) {
    if (typeof decrypted[field] === 'string' && decrypted[field]) {
      try {
        decrypted[field] = decryptApiKey(decrypted[field] as string);
      } catch (error) {
        // If decryption fails (e.g., key changed), leave as-is
        console.error(
          `[gateway-channels] Failed to decrypt ${field}:`,
          error instanceof Error ? error.message : String(error)
        );
        console.error(
          '[gateway-channels] Channel credentials may be corrupted or master secret changed'
        );
      }
    }
  }
  return decrypted;
}

function encryptAgenticConfig(
  agenticConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!agenticConfig) return null;

  const encrypted = { ...agenticConfig };
  const rawEnvVars = encrypted.envVars;

  if (Array.isArray(rawEnvVars)) {
    encrypted.envVars = (rawEnvVars as GatewayEnvVar[]).map((envVar) => ({
      ...envVar,
      value: envVar.value ? encryptApiKey(envVar.value) : envVar.value,
    }));
  } else if (rawEnvVars && typeof rawEnvVars === 'object') {
    // Legacy shape support: Record<string, string>
    encrypted.envVars = Object.fromEntries(
      Object.entries(rawEnvVars as Record<string, unknown>).map(([key, value]) => [
        key,
        typeof value === 'string' && value ? encryptApiKey(value) : value,
      ])
    );
  }

  return encrypted;
}

function decryptAgenticConfig(
  agenticConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!agenticConfig) return null;

  const decrypted = { ...agenticConfig };
  const rawEnvVars = decrypted.envVars;

  if (Array.isArray(rawEnvVars)) {
    decrypted.envVars = (rawEnvVars as GatewayEnvVar[]).map((envVar) => {
      try {
        return {
          ...envVar,
          value: envVar.value ? decryptApiKey(envVar.value) : envVar.value,
        };
      } catch {
        return envVar;
      }
    });
  } else if (rawEnvVars && typeof rawEnvVars === 'object') {
    // Legacy shape support: Record<string, string>
    decrypted.envVars = Object.fromEntries(
      Object.entries(rawEnvVars as Record<string, unknown>).map(([key, value]) => {
        if (typeof value !== 'string' || !value) return [key, value];
        try {
          return [key, decryptApiKey(value)];
        } catch {
          return [key, value];
        }
      })
    );
  }

  return decrypted;
}

/**
 * Gateway channel repository implementation
 */
export class GatewayChannelRepository
  implements BaseRepository<GatewayChannel, Partial<GatewayChannel>>
{
  constructor(private db: Database) {}

  /**
   * Convert database row to GatewayChannel type
   */
  private rowToChannel(row: GatewayChannelRow): GatewayChannel {
    const config = row.config as Record<string, unknown>;
    const agenticConfig = decryptAgenticConfig(
      (row.agentic_config as Record<string, unknown> | null) ?? null
    );

    return attachHiddenTenant(
      {
        id: row.id as GatewayChannelID,
        created_by: row.created_by,
        name: row.name,
        channel_type: row.channel_type as ChannelType,
        target_branch_id: row.target_branch_id as UUID,
        agor_user_id: row.agor_user_id as UUID,
        channel_key: row.channel_key,
        config: decryptConfig(config),
        agentic_config: (agenticConfig as unknown as GatewayAgenticConfig) ?? null,
        enabled: Boolean(row.enabled),
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
        last_message_at: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      },
      row
    );
  }

  /**
   * Convert GatewayChannel to database insert format
   */
  private channelToInsert(data: Partial<GatewayChannel>): GatewayChannelInsert {
    const now = Date.now();
    const id = data.id ?? generateId();
    if (!data.created_by) {
      throw new RepositoryError('GatewayChannel must have a created_by');
    }

    const channelType = data.channel_type ?? 'slack';
    const enabled = data.enabled ?? true;
    const config = data.config ?? {};

    const encryptedAgenticConfig = encryptAgenticConfig(
      (data.agentic_config as unknown as Record<string, unknown> | null) ?? null
    );

    return {
      id,
      created_at: new Date(data.created_at ?? now),
      updated_at: new Date(data.updated_at ?? now),
      created_by: data.created_by,
      name: data.name ?? 'Untitled Channel',
      channel_type: channelType,
      target_branch_id: data.target_branch_id ?? '',
      agor_user_id: data.agor_user_id ?? '',
      channel_key: data.channel_key ?? generateId(),
      enabled,
      last_message_at: data.last_message_at ? new Date(data.last_message_at) : null,
      config: encryptConfig(config),
      agentic_config: encryptedAgenticConfig,
    };
  }

  /**
   * Enforce the "enabled requires secrets" invariant on every write path.
   *
   * An enabled channel can never exist without the secrets its type needs to
   * function. Runs on the post-merge, decrypted config so a patch that only
   * flips `enabled: true` on a channel with already-stored tokens passes.
   * Disabled ("draft") channels are exempt.
   */
  private assertRequiredSecretsWhenEnabled(channel: Partial<GatewayChannel>): void {
    // Insert defaults `enabled` to true, so treat undefined as enabled here.
    if (channel.enabled === false) return;

    const channelType = channel.channel_type ?? 'slack';
    const config = channel.config ?? {};
    const missing = getRequiredSecretFields(channelType, config).filter((field) => {
      const value = config[field];
      return (
        typeof value !== 'string' || value.trim() === '' || value === GATEWAY_REDACTED_SENTINEL
      );
    });

    if (missing.length > 0) {
      throw new RepositoryError(
        `Cannot enable ${channelType} gateway channel: missing required secret(s) ${missing.join(', ')}`
      );
    }
  }

  /**
   * Resolve short ID to full ID
   */
  private async resolveId(id: string): Promise<string> {
    if (id.length === 36 && id.includes('-')) {
      return id;
    }

    const pattern = prefixToLikePattern(id);

    const results = await select(this.db)
      .from(gatewayChannels)
      .where(like(gatewayChannels.id, pattern))
      .all();

    if (results.length === 0) {
      throw new EntityNotFoundError('GatewayChannel', id);
    }

    if (results.length > 1) {
      throw new AmbiguousIdError(
        'GatewayChannel',
        id,
        results.map((r: { id: string }) => r.id)
      );
    }

    return results[0].id;
  }

  /**
   * Create a new gateway channel
   */
  async create(data: Partial<GatewayChannel>): Promise<GatewayChannel> {
    try {
      const insertData = this.channelToInsert({
        ...data,
        id: data.id ?? generateId(),
        channel_key: data.channel_key ?? generateId(),
      });

      this.assertRequiredSecretsWhenEnabled(data);

      await insert(this.db, gatewayChannels).values(insertData).run();

      const row = await select(this.db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.id, insertData.id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created gateway channel');
      }

      return this.rowToChannel(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create gateway channel: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find gateway channel by ID (supports short ID)
   */
  async findById(id: string): Promise<GatewayChannel | null> {
    try {
      const fullId = await this.resolveId(id);
      const row = await select(this.db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.id, fullId))
        .one();

      return row ? this.rowToChannel(row) : null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) return null;
      if (error instanceof AmbiguousIdError) throw error;
      throw new RepositoryError(
        `Failed to find gateway channel: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all gateway channels
   */
  async findAll(): Promise<GatewayChannel[]> {
    try {
      const rows = await select(this.db).from(gatewayChannels).all();
      return rows.map((row: GatewayChannelRow) => this.rowToChannel(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find all gateway channels: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Update gateway channel by ID
   */
  async update(id: string, updates: Partial<GatewayChannel>): Promise<GatewayChannel> {
    try {
      const fullId = await this.resolveId(id);
      return await this.db.transaction(async (tx) => {
        const txDb = txAsDb(tx);
        await lockRowForUpdate(txDb, this.db, gatewayChannels, eq(gatewayChannels.id, fullId));
        const currentRow = await select(txDb)
          .from(gatewayChannels)
          .where(eq(gatewayChannels.id, fullId))
          .one();
        if (!currentRow) throw new EntityNotFoundError('GatewayChannel', id);

        const current = this.rowToChannel(currentRow);
        const merged = { ...current, ...updates };
        if (updates.config) {
          const mergedConfig = { ...current.config, ...updates.config };
          for (const field of GATEWAY_SENSITIVE_CONFIG_FIELDS) {
            const updateValue = updates.config[field];
            if (
              (!updateValue || updateValue === GATEWAY_REDACTED_SENTINEL) &&
              current.config[field]
            ) {
              mergedConfig[field] = current.config[field];
            }
          }
          merged.config = mergedConfig;
        }

        this.assertRequiredSecretsWhenEnabled(merged);
        const insertData = this.channelToInsert(merged);
        const row = await update(txDb, gatewayChannels)
          .set({
            name: insertData.name,
            channel_type: insertData.channel_type,
            target_branch_id: insertData.target_branch_id,
            agor_user_id: insertData.agor_user_id,
            enabled: insertData.enabled,
            config: insertData.config,
            agentic_config: insertData.agentic_config,
            updated_at: new Date(),
          })
          .where(eq(gatewayChannels.id, fullId))
          .returning()
          .one();
        return this.rowToChannel(row);
      });
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to update gateway channel: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Merge non-secret channel runtime/config metadata into the platform config blob.
   *
   * This is intentionally a shallow config patch: callers that maintain nested
   * runtime state (for example a polling cursor) should pass the full nested
   * value they own. Existing credentials are preserved by the normal update()
   * credential-merge path.
   */
  async updateConfig(
    id: GatewayChannelID | string,
    configPatch: Record<string, unknown>
  ): Promise<GatewayChannel> {
    return this.update(id, {
      config: configPatch,
    });
  }

  private async mutateTelegramPollingState<Result>(
    id: GatewayChannelID | string,
    mutation: (state: TelegramPollingState) => { result: Result; nextState?: TelegramPollingState }
  ): Promise<Result> {
    const fullId = await this.resolveId(id);
    return runTransactionWithRetry(this.db, async (txDb) => {
      await lockRowForUpdate(txDb, this.db, gatewayChannels, eq(gatewayChannels.id, fullId));
      const currentRow = await select(txDb)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.id, fullId))
        .one();
      if (!currentRow) throw new EntityNotFoundError('GatewayChannel', id);

      const current = this.rowToChannel(currentRow);
      const outcome = mutation(telegramPollingState(current));
      if (outcome.nextState) {
        const insertData = this.channelToInsert({
          ...current,
          config: { ...current.config, telegram_polling_state: outcome.nextState },
        });
        await update(txDb, gatewayChannels)
          .set({ config: insertData.config, updated_at: new Date() })
          .where(eq(gatewayChannels.id, fullId))
          .run();
      }
      return outcome.result;
    });
  }

  /**
   * Atomically inspect and claim one Telegram polling update.
   *
   * The row lock and config write share one transaction, so an active claim is
   * never reported as acquired to a second listener callback. Stale claims may
   * be replaced after the caller-owned lease duration.
   */
  async claimTelegramPollingUpdate(
    id: GatewayChannelID | string,
    updateId: number,
    options: { staleAfterMs: number; now?: Date }
  ): Promise<TelegramPollingUpdateClaimResult> {
    return this.mutateTelegramPollingState<TelegramPollingUpdateClaimResult>(id, (state) => {
      if (telegramUpdateWasProcessed(state, updateId)) {
        return { result: { status: 'processed' as const } };
      }

      const inflight = telegramInflightUpdate(state);
      if (
        inflight?.update_id === updateId &&
        inflight.status === 'side_effects_completed' &&
        inflight.lease_token
      ) {
        return {
          result: {
            status: 'side_effects_completed' as const,
            leaseToken: inflight.lease_token,
          },
        };
      }

      const now = options.now ?? new Date();
      if (inflight) {
        const updatedAt = Date.parse(inflight.updated_at);
        const stale =
          !Number.isFinite(updatedAt) || now.getTime() - updatedAt >= options.staleAfterMs;
        if (!stale) {
          return {
            result: {
              status: 'active' as const,
              inflightStatus: inflight.status,
              updateId: inflight.update_id,
            },
          };
        }
      }

      const leaseToken = generateId();
      const nextState: TelegramPollingState = {
        ...state,
        inflight_update: {
          update_id: updateId,
          status: 'reserved',
          updated_at: now.toISOString(),
          lease_token: leaseToken,
        },
      };
      return {
        result: {
          status: 'acquired' as const,
          reclaimed: Boolean(inflight),
          leaseToken,
        },
        nextState,
      };
    });
  }

  async markTelegramPollingSideEffectsStarted(
    id: GatewayChannelID | string,
    updateId: number,
    leaseToken: string,
    now = new Date()
  ): Promise<boolean> {
    return this.mutateTelegramPollingState(id, (state) => {
      const inflight = telegramLeaseMatches(state, updateId, leaseToken);
      if (inflight?.status !== 'reserved') return { result: false };
      return {
        result: true,
        nextState: {
          ...state,
          inflight_update: {
            ...inflight,
            status: 'side_effects_started',
            updated_at: now.toISOString(),
          },
        },
      };
    });
  }

  async markTelegramPollingSideEffectsCompleted(
    id: GatewayChannelID | string,
    updateId: number,
    leaseToken: string,
    now = new Date()
  ): Promise<boolean> {
    return this.mutateTelegramPollingState(id, (state) => {
      const inflight = telegramLeaseMatches(state, updateId, leaseToken);
      if (inflight?.status !== 'side_effects_started') return { result: false };
      return {
        result: true,
        nextState: {
          ...state,
          inflight_update: {
            ...inflight,
            status: 'side_effects_completed',
            updated_at: now.toISOString(),
          },
        },
      };
    });
  }

  async releaseTelegramPollingUpdate(
    id: GatewayChannelID | string,
    updateId: number,
    leaseToken: string
  ): Promise<boolean> {
    return this.mutateTelegramPollingState(id, (state) => {
      if (!telegramLeaseMatches(state, updateId, leaseToken)) return { result: false };
      const nextState = { ...state };
      delete nextState.inflight_update;
      return { result: true, nextState };
    });
  }

  async acknowledgeTelegramPollingUpdate(
    id: GatewayChannelID | string,
    updateId: number,
    leaseToken: string,
    now = new Date()
  ): Promise<boolean> {
    return this.mutateTelegramPollingState(id, (state) => {
      const inflight = telegramLeaseMatches(state, updateId, leaseToken);
      if (inflight?.status !== 'side_effects_completed') return { result: false };
      const lastProcessed = telegramSafeUpdateId(state.last_processed_update_id);
      const nextState: TelegramPollingState = {
        ...state,
        last_processed_update_id:
          lastProcessed === undefined ? updateId : Math.max(lastProcessed, updateId),
        acknowledged_at: now.toISOString(),
        recent_processed_update_ids: appendTelegramProcessedUpdateId(state, updateId),
      };
      delete nextState.inflight_update;
      return { result: true, nextState };
    });
  }

  /**
   * Delete gateway channel by ID
   */
  async delete(id: string): Promise<void> {
    try {
      const fullId = await this.resolveId(id);

      const result = await deleteFrom(this.db, gatewayChannels)
        .where(eq(gatewayChannels.id, fullId))
        .run();

      if (result.rowsAffected === 0) {
        throw new EntityNotFoundError('GatewayChannel', id);
      }
    } catch (error) {
      if (error instanceof EntityNotFoundError) throw error;
      throw new RepositoryError(
        `Failed to delete gateway channel: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find gateway channel by channel_key (auth lookup for inbound webhooks)
   */
  async findByKey(channelKey: string): Promise<GatewayChannel | null> {
    try {
      const row = await select(this.db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.channel_key, channelKey))
        .one();

      return row ? this.rowToChannel(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find gateway channel by key: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find all gateway channels for a user
   */
  async findByUser(userId: string): Promise<GatewayChannel[]> {
    try {
      const rows = await select(this.db)
        .from(gatewayChannels)
        .where(eq(gatewayChannels.agor_user_id, userId))
        .all();

      return rows.map((row: GatewayChannelRow) => this.rowToChannel(row));
    } catch (error) {
      throw new RepositoryError(
        `Failed to find gateway channels by user: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Touch last_message_at timestamp
   */
  async updateLastMessage(id: GatewayChannelID): Promise<void> {
    try {
      await update(this.db, gatewayChannels)
        .set({
          last_message_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(gatewayChannels.id, id))
        .run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to update last message timestamp: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
