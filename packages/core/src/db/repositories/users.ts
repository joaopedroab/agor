/**
 * Users Repository
 *
 * Type-safe CRUD operations for users with encrypted per-tool credential management.
 * Credentials live under `data.agentic_tools[toolName][envVarName]`, encrypted at rest;
 * the public DTO (User.agentic_tools) exposes boolean presence flags only.
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  AgenticToolName,
  AgenticToolsConfig,
  EnvVarMetadata,
  InternalUser,
  StoredAgenticTools,
  User,
  UserExternalIdentity,
  UserExternalIdentityLinkToken,
  UUID,
} from '@agor/core/types';
import { toAgenticToolsStatus } from '@agor/core/types';
import { eq, like, sql } from 'drizzle-orm';
import { normalizeStoredEnvMap, type RawStoredEnvVar } from '../../config/env-vars';
import { generateId, shortId } from '../../lib/ids';
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
import { type UserInsert as SchemaUserInsert, type UserRow, users } from '../schema';
import {
  type BaseRepository,
  EntityNotFoundError,
  RESOLVE_SHORT_ID_FETCH_LIMIT,
  RepositoryError,
  resolveByShortIdPrefix,
} from './base';

export interface ExternalIdentityRef {
  provider: string;
  issuer: string;
  subject: string;
}

export interface LinkExternalIdentityInput extends ExternalIdentityRef {
  email?: string;
  name?: string;
  last_login_at?: string;
}

export interface CreateExternalIdentityLinkTokenInput {
  provider: string;
  issuer: string;
  purpose: 'telegram_dm_link' | string;
  intended_user_id: string;
  created_by_user_id: string;
  expires_at: string;
  token?: string;
}

export interface CreateExternalIdentityLinkTokenResult {
  token: string;
  token_id: string;
  user_id: string;
  provider: string;
  issuer: string;
  purpose: string;
  expires_at: string;
}

export type ConsumeExternalIdentityLinkTokenResult =
  | {
      ok: true;
      user_id: string;
      token_id: string;
      external_identity: UserExternalIdentity;
    }
  | {
      ok: false;
      reason:
        | 'invalid_token'
        | 'expired_token'
        | 'used_token'
        | 'ambiguous_token'
        | 'already_linked'
        | 'ambiguous_link'
        | 'target_user_not_found';
    };

type StoredUserData = UserRow['data'] & {
  external_identities?: UserExternalIdentity[];
  external_identity_link_tokens?: UserExternalIdentityLinkToken[];
};

/**
 * Stable lookup key for explicit external account links.
 *
 * Keep this aligned with launch-auth's identity key shape so a local Agor user
 * can own stable identities from multiple external surfaces without a new
 * provider-specific table for each gateway.
 */
export function externalIdentityKey(provider: string, issuer: string, subject: string): string {
  return createHash('sha256').update(`${provider}\0${issuer}\0${subject}`).digest('hex');
}

function getExternalIdentities(data: StoredUserData | null | undefined): UserExternalIdentity[] {
  return Array.isArray(data?.external_identities) ? data.external_identities : [];
}

function getExternalIdentityLinkTokens(
  data: StoredUserData | null | undefined
): UserExternalIdentityLinkToken[] {
  return Array.isArray(data?.external_identity_link_tokens)
    ? data.external_identity_link_tokens
    : [];
}

function externalIdentityLinkTokenHash(provider: string, issuer: string, token: string): string {
  return createHash('sha256').update(`${provider}\0${issuer}\0${token}`).digest('hex');
}

function generateLinkToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Users repository implementation
 */
export class UsersRepository implements BaseRepository<InternalUser, Partial<InternalUser>> {
  constructor(private db: Database) {}

  /**
   * Convert database row to User type.
   * Converts the encrypted `agentic_tools` blob to a boolean presence DTO so
   * decrypted credentials never leave this repository.
   */
  private rowToUser(row: UserRow): InternalUser {
    return {
      user_id: row.user_id as UUID,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
      email: row.email,
      name: row.name ?? undefined,
      emoji: row.emoji ?? undefined,
      role: row.role,
      unix_username: row.unix_username ?? undefined,
      onboarding_completed: row.onboarding_completed,
      must_change_password: row.must_change_password,
      tokens_valid_after: row.tokens_valid_after ? new Date(row.tokens_valid_after) : undefined,
      avatar_url: row.data.avatar_url ?? row.data.avatar,
      avatar: row.data.avatar,
      avatar_source: row.data.avatar_source,
      avatar_source_id: row.data.avatar_source_id,
      avatar_synced_at: row.data.avatar_synced_at,
      preferences: row.data.preferences as User['preferences'],
      // Convert encrypted per-tool credential blobs into boolean presence flags.
      agentic_tools: toAgenticToolsStatus(row.data.agentic_tools as StoredAgenticTools | undefined),
      // Convert stored env vars to presence + scope metadata (never exposes secrets).
      // Handles both legacy string form and v0.5 object form via normalizeStoredEnvMap.
      // The schema stores `scope` as a generic string (no SQL CHECK constraint); the
      // normalizer and app-layer validation narrow it to EnvVarScope.
      env_vars: (() => {
        const normalized = normalizeStoredEnvMap(
          row.data.env_vars as Record<string, RawStoredEnvVar> | undefined
        );
        if (Object.keys(normalized).length === 0) return undefined;
        const out: Record<string, EnvVarMetadata> = {};
        for (const [name, entry] of Object.entries(normalized)) {
          out[name] = { set: true, scope: entry.scope, resource_id: entry.resource_id ?? null };
        }
        return out;
      })(),
      default_agentic_config: row.data.default_agentic_config as User['default_agentic_config'],
    };
  }

  /**
   * Convert User to database insert format
   * For updates, this accepts the current user data from the database row
   */
  private userToInsert(
    user: Partial<InternalUser> & {
      password?: string;
      agentic_tools_raw?: StoredAgenticTools;
      env_vars_raw?: SchemaUserInsert['data']['env_vars'];
      external_identities_raw?: UserExternalIdentity[];
      external_identity_link_tokens_raw?: UserExternalIdentityLinkToken[];
    }
  ): SchemaUserInsert {
    const now = new Date();
    const userId = user.user_id ?? generateId();

    if (!user.email) {
      throw new RepositoryError('User must have an email');
    }

    return {
      user_id: userId,
      created_at: user.created_at ? new Date(user.created_at) : now,
      updated_at: user.updated_at ? new Date(user.updated_at) : now,
      email: user.email,
      password: user.password ?? '', // Password required, but handled by services layer
      name: user.name ?? null,
      emoji: user.emoji ?? null,
      role: user.role ?? 'member',
      unix_username: user.unix_username ?? null,
      onboarding_completed: user.onboarding_completed ?? false,
      must_change_password: user.must_change_password ?? false,
      tokens_valid_after: user.tokens_valid_after ? new Date(user.tokens_valid_after) : null,
      data: {
        avatar_url: user.avatar_url,
        avatar: user.avatar,
        avatar_source: user.avatar_source,
        avatar_source_id: user.avatar_source_id,
        avatar_synced_at: user.avatar_synced_at,
        preferences: user.preferences,
        // Encrypted per-tool credentials. Only forwarded when caller passes the
        // raw shape (internal credential mutators); regular updates leave it undefined,
        // letting the merge in `update()` reuse the existing on-disk blob.
        // Cast: schema declares `opencode: Record<string, never>` (no fields by
        // contract); StoredAgenticTools widens that to string values for shape
        // uniformity. Runtime never writes opencode, so the cast is safe.
        agentic_tools: user.agentic_tools_raw as SchemaUserInsert['data']['agentic_tools'],
        // Same pass-through as agentic_tools: env_vars are encrypted blobs
        // not represented on the public DTO. `update()` threads the raw value
        // from the existing row so a generic field update doesn't wipe them.
        env_vars: user.env_vars_raw,
        // Stable external account links are internal user data. Preserve them
        // across generic profile/preference updates just like credential blobs.
        external_identities: user.external_identities_raw,
        external_identity_link_tokens: user.external_identity_link_tokens_raw,
        default_agentic_config: user.default_agentic_config,
      },
    };
  }

  /**
   * Resolve short ID to full ID via the centralized helper.
   */
  private async resolveId(id: string): Promise<string> {
    return resolveByShortIdPrefix(id, 'User', async (pattern) => {
      const rows = await select(this.db)
        .from(users)
        .where(like(users.user_id, pattern))
        .limit(RESOLVE_SHORT_ID_FETCH_LIMIT)
        .all();
      return rows.map((r: UserRow) => r.user_id);
    });
  }

  /**
   * Check if unix_username is already taken by another user
   */
  private async isUnixUsernameTaken(
    unixUsername: string,
    excludeUserId?: string
  ): Promise<boolean> {
    const result = await select(this.db)
      .from(users)
      .where(eq(users.unix_username, unixUsername))
      .one();

    if (!result) {
      return false;
    }

    // If excluding a user ID (for updates), check if it's a different user
    if (excludeUserId && result.user_id === excludeUserId) {
      return false;
    }

    return true;
  }

  /**
   * Create a new user
   */
  async create(data: Partial<InternalUser>): Promise<InternalUser> {
    // Validate unix_username uniqueness if provided
    if (data.unix_username) {
      const isTaken = await this.isUnixUsernameTaken(data.unix_username);
      if (isTaken) {
        throw new RepositoryError(
          `Unix username "${data.unix_username}" is already in use by another user`
        );
      }
    }

    const insertData = this.userToInsert(data);

    await insert(this.db, users).values(insertData).run();

    const row = await select(this.db)
      .from(users)
      .where(eq(users.user_id, insertData.user_id))
      .one();

    if (!row) {
      throw new RepositoryError('Failed to retrieve created user');
    }

    return this.rowToUser(row as UserRow);
  }

  /**
   * Find user by ID (supports short ID resolution)
   */
  async findById(id: string): Promise<InternalUser | null> {
    try {
      const fullId = await this.resolveId(id);

      const result = await select(this.db).from(users).where(eq(users.user_id, fullId)).one();

      if (!result) {
        return null;
      }

      return this.rowToUser(result as UserRow);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Find user by email
   */
  async findByEmail(email: string): Promise<InternalUser | null> {
    const result = await select(this.db).from(users).where(eq(users.email, email)).one();

    if (!result) {
      return null;
    }

    return this.rowToUser(result as UserRow);
  }

  /**
   * Find user by email for external identity providers.
   *
   * Agor intentionally keeps exact/case-sensitive email lookup semantics for
   * auth paths because the schema historically allowed case-distinct emails.
   * External providers such as Slack and GitHub treat email addresses as a
   * canonical identity hint, so their alignment path needs a case-insensitive
   * match. Prefer an exact match when present; otherwise return a
   * case-insensitive match only when it is unambiguous.
   */
  async findByEmailForAlignment(email: string): Promise<InternalUser | null> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) return null;

    const exact = await this.findByEmail(normalizedEmail);
    if (exact) return exact;

    const results = await select(this.db)
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`)
      .all();

    if (results.length !== 1) {
      if (results.length > 1) {
        console.warn(
          `[users] Ambiguous case-insensitive email alignment for ${normalizedEmail}: ${results
            .map((row: unknown) => {
              const userRow = row as UserRow;
              return `${shortId(userRow.user_id)}:${userRow.email}`;
            })
            .join(', ')}`
        );
      }
      return null;
    }

    return this.rowToUser(results[0] as UserRow);
  }

  /**
   * Find a user by an explicitly linked external identity.
   *
   * Used by gateway providers that have a stable external account identifier
   * but no trustworthy email address. The lookup is intentionally generic:
   * callers decide the provider/issuer namespace (e.g. provider="telegram",
   * issuer="telegram", subject=<numeric Telegram user.id>).
   */
  async findByExternalIdentity(ref: ExternalIdentityRef): Promise<InternalUser | null> {
    const matches = await this.findUsersByExternalIdentity(ref);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      console.warn(
        `[users] Ambiguous external identity link for provider=${ref.provider} issuer=${ref.issuer} subject=${ref.subject}: ${matches
          .map((user) => shortId(user.user_id))
          .join(', ')}`
      );
      return null;
    }
    return matches[0];
  }

  /**
   * Return every user currently carrying an explicit external identity link.
   *
   * Gateway auth boundaries can use this to fail closed on duplicate persisted
   * links instead of treating "not exactly one" as an implicit fallback path.
   */
  async findUsersByExternalIdentity(ref: ExternalIdentityRef): Promise<InternalUser[]> {
    const key = externalIdentityKey(ref.provider, ref.issuer, ref.subject);
    const rows = await select(this.db).from(users).all();
    const matches: InternalUser[] = [];
    for (const row of rows) {
      const userRow = row as UserRow;
      const identities = getExternalIdentities(userRow.data as StoredUserData);
      if (identities.some((identity) => identity.key === key)) {
        matches.push(this.rowToUser(userRow));
      }
    }
    return matches;
  }

  /**
   * List explicit external identities for one user.
   *
   * This keeps listing/revocation inside the repository boundary without
   * exposing the raw encrypted user-data blob to future admin services.
   */
  async listExternalIdentities(userId: string): Promise<UserExternalIdentity[]> {
    const fullId = await this.resolveId(userId);
    const row = await select(this.db).from(users).where(eq(users.user_id, fullId)).one();
    if (!row) {
      throw new EntityNotFoundError('User', userId);
    }
    const data = ((row as UserRow).data ?? {}) as StoredUserData;
    return [...getExternalIdentities(data)];
  }

  /**
   * Remove one explicit external identity link from a user.
   *
   * This is a local account-link revocation boundary only; it does not call any
   * provider APIs or revoke provider-side credentials.
   */
  async unlinkExternalIdentity(userId: string, ref: ExternalIdentityRef): Promise<InternalUser> {
    const fullId = await this.resolveId(userId);
    return this.db.transaction(async (tx) => {
      const txDb = txAsDb(tx);
      await lockRowForUpdate(txDb, this.db, users, eq(users.user_id, fullId));
      const row = await select(txDb).from(users).where(eq(users.user_id, fullId)).one();
      if (!row) throw new EntityNotFoundError('User', userId);

      const data = ((row as UserRow).data ?? {}) as StoredUserData;
      const key = externalIdentityKey(ref.provider, ref.issuer, ref.subject);
      const updated = await update(txDb, users)
        .set({
          data: {
            ...data,
            external_identities: getExternalIdentities(data).filter(
              (identity) => identity.key !== key
            ),
          },
          updated_at: new Date(),
        })
        .where(eq(users.user_id, fullId))
        .returning()
        .one();
      return this.rowToUser(updated as UserRow);
    });
  }

  /**
   * Link or refresh one external identity on an existing user.
   *
   * This writes only `users.data.external_identities`; it does not create users,
   * merge by email, or imply that a gateway may fall back to a channel owner.
   */
  async linkExternalIdentity(
    userId: string,
    input: LinkExternalIdentityInput
  ): Promise<InternalUser> {
    const fullId = await this.resolveId(userId);
    const key = externalIdentityKey(input.provider, input.issuer, input.subject);
    return this.db.transaction(async (tx) => {
      const txDb = txAsDb(tx);
      // External identities live in users.data, so serialize this small admin/link
      // mutation across user rows instead of adding a provider-specific table.
      await lockRowForUpdate(txDb, this.db, users, sql`true`);
      const rows = (await select(txDb).from(users).all()) as UserRow[];
      const row = rows.find((candidate) => candidate.user_id === fullId);
      if (!row) throw new EntityNotFoundError('User', userId);
      const owner = rows.find(
        (candidate) =>
          candidate.user_id !== fullId &&
          getExternalIdentities(candidate.data as StoredUserData).some(
            (identity) => identity.key === key
          )
      );
      if (owner) {
        throw new RepositoryError(
          `External identity ${input.provider}:${input.issuer}:${input.subject} is already linked to another user`
        );
      }

      const data = (row.data ?? {}) as StoredUserData;
      const identity: UserExternalIdentity = {
        key,
        provider: input.provider,
        issuer: input.issuer,
        subject: input.subject,
        ...(input.email ? { email: input.email } : {}),
        ...(input.name ? { name: input.name } : {}),
        last_login_at: input.last_login_at ?? new Date().toISOString(),
      };
      const existing = getExternalIdentities(data);
      const external_identities = existing.some((candidate) => candidate.key === key)
        ? existing.map((candidate) =>
            candidate.key === key ? { ...candidate, ...identity } : candidate
          )
        : [...existing, identity];
      const updated = await update(txDb, users)
        .set({ data: { ...data, external_identities }, updated_at: new Date() })
        .where(eq(users.user_id, fullId))
        .returning()
        .one();
      return this.rowToUser(updated as UserRow);
    });
  }

  /**
   * Create a short-lived, single-use local token for linking an external
   * identity to an existing user. The raw token is returned once and only its
   * hash is stored in users.data.
   */
  async createExternalIdentityLinkToken(
    input: CreateExternalIdentityLinkTokenInput
  ): Promise<CreateExternalIdentityLinkTokenResult> {
    const intendedUserId = await this.resolveId(input.intended_user_id);
    const now = new Date().toISOString();
    const token = input.token ?? generateLinkToken();
    const tokenRecord: UserExternalIdentityLinkToken = {
      token_id: generateId(),
      token_hash: externalIdentityLinkTokenHash(input.provider, input.issuer, token),
      provider: input.provider,
      issuer: input.issuer,
      purpose: input.purpose,
      intended_user_id: intendedUserId,
      created_by_user_id: input.created_by_user_id,
      created_at: now,
      expires_at: input.expires_at,
    };
    await this.db.transaction(async (tx) => {
      const txDb = txAsDb(tx);
      await lockRowForUpdate(txDb, this.db, users, eq(users.user_id, intendedUserId));
      const row = await select(txDb).from(users).where(eq(users.user_id, intendedUserId)).one();
      if (!row) throw new EntityNotFoundError('User', input.intended_user_id);
      const data = ((row as UserRow).data ?? {}) as StoredUserData;
      const activeTokens = getExternalIdentityLinkTokens(data)
        .filter(
          (candidate) => candidate.consumed_at || Date.parse(candidate.expires_at) > Date.now()
        )
        .slice(-24);
      await update(txDb, users)
        .set({
          data: {
            ...data,
            external_identity_link_tokens: [...activeTokens, tokenRecord],
          },
          updated_at: new Date(),
        })
        .where(eq(users.user_id, intendedUserId))
        .run();
    });

    return {
      token,
      token_id: tokenRecord.token_id,
      user_id: intendedUserId,
      provider: input.provider,
      issuer: input.issuer,
      purpose: input.purpose,
      expires_at: input.expires_at,
    };
  }

  /**
   * Verify and consume a local external-identity link token, then attach the
   * external identity to the token's intended user. Fails closed for missing,
   * expired, reused, duplicate, or ambiguous state.
   */
  async consumeExternalIdentityLinkToken(input: {
    provider: string;
    issuer: string;
    purpose: 'telegram_dm_link' | string;
    token: string;
    subject: string;
    email?: string;
    name?: string;
    now?: Date;
  }): Promise<ConsumeExternalIdentityLinkTokenResult> {
    const tokenHash = externalIdentityLinkTokenHash(input.provider, input.issuer, input.token);
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();

    return runTransactionWithRetry(this.db, async (txDb) => {
      // The token and identity both live in users.data. Lock the small user set
      // before checking either so two tokens cannot claim the same subject and
      // two consumers cannot spend the same token from stale preimages.
      await lockRowForUpdate(txDb, this.db, users, sql`true`);
      const rows = (await select(txDb).from(users).all()) as UserRow[];
      const tokenMatches: Array<{ row: UserRow; token: UserExternalIdentityLinkToken }> = [];

      for (const row of rows) {
        const data = (row.data ?? {}) as StoredUserData;
        for (const candidate of getExternalIdentityLinkTokens(data)) {
          if (
            candidate.provider === input.provider &&
            candidate.issuer === input.issuer &&
            candidate.purpose === input.purpose &&
            candidate.token_hash === tokenHash
          ) {
            tokenMatches.push({ row, token: candidate });
          }
        }
      }

      if (tokenMatches.length === 0)
        return { ok: false as const, reason: 'invalid_token' as const };
      if (tokenMatches.length > 1)
        return { ok: false as const, reason: 'ambiguous_token' as const };

      const [{ row: tokenRow, token: storedToken }] = tokenMatches;
      if (storedToken.consumed_at) return { ok: false as const, reason: 'used_token' as const };
      const expiresAtMs = Date.parse(storedToken.expires_at);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
        return { ok: false as const, reason: 'expired_token' as const };
      }
      if (storedToken.intended_user_id !== tokenRow.user_id) {
        return { ok: false as const, reason: 'target_user_not_found' as const };
      }

      const key = externalIdentityKey(input.provider, input.issuer, input.subject);
      const existingMatches = rows.filter((candidate) => {
        const identities = getExternalIdentities(candidate.data as StoredUserData);
        return identities.some((identity) => identity.key === key);
      });
      if (existingMatches.length > 1)
        return { ok: false as const, reason: 'ambiguous_link' as const };
      if (existingMatches.length === 1)
        return { ok: false as const, reason: 'already_linked' as const };

      const targetData = (tokenRow.data ?? {}) as StoredUserData;
      const externalIdentity: UserExternalIdentity = {
        key,
        provider: input.provider,
        issuer: input.issuer,
        subject: input.subject,
        ...(input.email ? { email: input.email } : {}),
        ...(input.name ? { name: input.name } : {}),
        last_login_at: nowIso,
      };
      const external_identity_link_tokens = getExternalIdentityLinkTokens(targetData).map(
        (candidate) =>
          candidate.token_id === storedToken.token_id
            ? {
                ...candidate,
                consumed_at: nowIso,
                consumed_by_subject: input.subject,
              }
            : candidate
      );
      const result = await update(txDb, users)
        .set({
          data: {
            ...targetData,
            external_identities: [...getExternalIdentities(targetData), externalIdentity],
            external_identity_link_tokens,
          },
          updated_at: new Date(),
        })
        .where(eq(users.user_id, tokenRow.user_id))
        .run();

      if (result.rowsAffected === 1) {
        return {
          ok: true as const,
          user_id: tokenRow.user_id,
          token_id: storedToken.token_id,
          external_identity: externalIdentity,
        };
      }
      return { ok: false as const, reason: 'target_user_not_found' as const };
    });
  }

  /**
   * Find all users
   */
  async findAll(): Promise<InternalUser[]> {
    const results = await select(this.db).from(users).all();

    return results.map((row: UserRow) => this.rowToUser(row));
  }

  /**
   * Update user by ID
   */
  async update(id: string, updates: Partial<InternalUser>): Promise<InternalUser> {
    const fullId = await this.resolveId(id);
    return this.db.transaction(async (tx) => {
      const txDb = txAsDb(tx);
      await lockRowForUpdate(txDb, this.db, users, eq(users.user_id, fullId));
      const rawRow = (await select(txDb)
        .from(users)
        .where(eq(users.user_id, fullId))
        .one()) as UserRow | null;
      if (!rawRow) throw new EntityNotFoundError('User', id);

      const current = this.rowToUser(rawRow);
      if (updates.unix_username && updates.unix_username !== current.unix_username) {
        const owner = await select(txDb)
          .from(users)
          .where(eq(users.unix_username, updates.unix_username))
          .one();
        if (owner && owner.user_id !== fullId) {
          throw new RepositoryError(
            `Unix username "${updates.unix_username}" is already in use by another user`
          );
        }
      }

      // Internal JSON fields are not projected on the public user DTO; preserve
      // them from the locked row so profile updates cannot overwrite a link or token.
      const merged = { ...current, ...updates } as Partial<InternalUser> & {
        agentic_tools_raw?: StoredAgenticTools;
        env_vars_raw?: SchemaUserInsert['data']['env_vars'];
        external_identities_raw?: UserExternalIdentity[];
        external_identity_link_tokens_raw?: UserExternalIdentityLinkToken[];
      };
      if (rawRow.data.agentic_tools) {
        merged.agentic_tools_raw = rawRow.data.agentic_tools as StoredAgenticTools;
      }
      if (rawRow.data.env_vars) merged.env_vars_raw = rawRow.data.env_vars;
      if (rawRow.data.external_identities) {
        merged.external_identities_raw = rawRow.data.external_identities;
      }
      if (rawRow.data.external_identity_link_tokens) {
        merged.external_identity_link_tokens_raw = rawRow.data.external_identity_link_tokens;
      }

      const row = await update(txDb, users)
        .set({ ...this.userToInsert(merged), updated_at: new Date() })
        .where(eq(users.user_id, fullId))
        .returning()
        .one();
      return this.rowToUser(row as UserRow);
    });
  }

  /**
   * Delete user by ID
   */
  async delete(id: string): Promise<void> {
    const fullId = await this.resolveId(id);

    await deleteFrom(this.db, users).where(eq(users.user_id, fullId)).run();
  }

  /**
   * Get raw database row (internal use only - includes encrypted keys)
   */
  private async getRawRow(id: string): Promise<UserRow | null> {
    try {
      const fullId = await this.resolveId(id);

      const result = await select(this.db).from(users).where(eq(users.user_id, fullId)).one();

      return result as UserRow | null;
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get the full decrypted credential bag for a single agentic tool.
   *
   * Returns `null` when the user has no stored config for that tool.
   * Fields that fail to decrypt are dropped from the returned object and
   * logged — callers see "missing field" rather than a thrown error so a
   * single corrupt value doesn't poison an entire SDK spawn.
   */
  async getToolConfig<T extends AgenticToolName>(
    userId: string,
    tool: T
  ): Promise<AgenticToolsConfig[T] | null> {
    const row = await this.getRawRow(userId);
    if (!row) return null;

    const stored = row.data.agentic_tools as StoredAgenticTools | undefined;
    const fields = stored?.[tool];
    if (!fields || Object.keys(fields).length === 0) return null;

    const out: Record<string, string> = {};
    for (const [field, encrypted] of Object.entries(fields)) {
      if (!encrypted) continue;
      try {
        out[field] = decryptApiKey(encrypted);
      } catch (error) {
        console.error(
          `[users] Failed to decrypt ${tool}.${field} for user ${shortId(userId)}: ${
            (error as Error).message
          }`
        );
      }
    }

    return Object.keys(out).length > 0 ? (out as AgenticToolsConfig[T]) : null;
  }

  /**
   * Get a single decrypted credential field for a tool.
   *
   * Returns `null` when the field is unset OR when decryption fails (logged).
   * Throws only on storage-layer errors, not on missing/corrupt values.
   */
  async getToolConfigField<T extends AgenticToolName>(
    userId: string,
    tool: T,
    field: keyof NonNullable<AgenticToolsConfig[T]> & string
  ): Promise<string | null> {
    const row = await this.getRawRow(userId);
    if (!row) return null;

    const stored = row.data.agentic_tools as StoredAgenticTools | undefined;
    const encrypted = stored?.[tool]?.[field];
    if (!encrypted) return null;

    try {
      return decryptApiKey(encrypted);
    } catch (error) {
      console.error(
        `[users] Failed to decrypt ${tool}.${field} for user ${shortId(userId)}: ${
          (error as Error).message
        }`
      );
      return null;
    }
  }

  /**
   * Set (encrypt + persist) a single credential field for a tool.
   *
   * Field names are env-var-shaped (e.g. ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL)
   * and are stored encrypted regardless of whether the value is a secret —
   * keeping the on-disk shape uniform avoids decrypt-vs-plain branching at
   * read time. UI controls own the text-vs-password rendering distinction.
   */
  async setToolConfigField<T extends AgenticToolName>(
    userId: string,
    tool: T,
    field: keyof NonNullable<AgenticToolsConfig[T]> & string,
    value: string
  ): Promise<void> {
    const fullId = await this.resolveId(userId);
    const row = await this.getRawRow(fullId);

    if (!row) {
      throw new EntityNotFoundError('User', userId);
    }

    const stored = (row.data.agentic_tools as StoredAgenticTools | undefined) ?? {};
    const next: StoredAgenticTools = {
      ...stored,
      [tool]: {
        ...(stored[tool] ?? {}),
        [field]: encryptApiKey(value),
      },
    };

    // Patch ONLY the agentic_tools sub-blob — preserve siblings (env_vars,
    // preferences, default_agentic_config, etc.). Routing through
    // userToInsert would lose any data subfield it doesn't explicitly
    // forward (e.g. env_vars), which is how a credential write would
    // otherwise nuke unrelated user state.
    await update(this.db, users)
      .set({
        data: { ...row.data, agentic_tools: next },
        updated_at: new Date(),
      })
      .where(eq(users.user_id, fullId))
      .run();
  }

  /**
   * Delete a single credential field for a tool.
   *
   * If the tool's bucket becomes empty after the delete, the bucket itself is
   * removed so `data.agentic_tools` doesn't accumulate empty objects.
   */
  async deleteToolConfigField<T extends AgenticToolName>(
    userId: string,
    tool: T,
    field: keyof NonNullable<AgenticToolsConfig[T]> & string
  ): Promise<void> {
    const fullId = await this.resolveId(userId);
    const row = await this.getRawRow(fullId);

    if (!row) {
      throw new EntityNotFoundError('User', userId);
    }

    const stored = (row.data.agentic_tools as StoredAgenticTools | undefined) ?? {};
    const toolFields = { ...(stored[tool] ?? {}) } as Record<string, string>;
    delete toolFields[field];

    const next: StoredAgenticTools = { ...stored };
    if (Object.keys(toolFields).length > 0) {
      next[tool] = toolFields;
    } else {
      delete next[tool];
    }

    // Patch only agentic_tools — see setToolConfigField for rationale.
    await update(this.db, users)
      .set({
        data: { ...row.data, agentic_tools: next },
        updated_at: new Date(),
      })
      .where(eq(users.user_id, fullId))
      .run();
  }
}
