import { connect, NatsConnection, Subscription, StringCodec } from 'nats';
import WebSocket from 'ws';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { join } from 'node:path';
import {
  fetchAnimaContext,
  getCurrentGroupId,
  buildContextPrefix,
  processInboxMessage,
  publishTokenEstimate,
  maybeRecordInteraction,
  runInDispatchContext,
  type GroupContext,
  type InboxHandlerConfig,
} from '@bolter2/anima-core';

const sc = StringCodec();

/** Simple counting semaphore to bound concurrent dispatches. */
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) { this.active++; return; }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) { next(); } else { this.active--; }
  }
}

const dispatchSemaphore = new Semaphore(3);

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

function loadDeviceIdentity(): DeviceIdentity | null {
  try {
    const home = process.env.HOME || '/home/node';
    const filePath = join(home, '.openclaw', 'device-identity.json');
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    if (data?.version === 1 && data.deviceId && data.publicKeyPem && data.privateKeyPem) {
      return { deviceId: data.deviceId, publicKeyPem: data.publicKeyPem, privateKeyPem: data.privateKeyPem };
    }
  } catch {}
  return null;
}

function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce: string;
}): string {
  return [
    'v2',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token,
    params.nonce,
  ].join('|');
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(payload, 'utf8'), key);
  return sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derivePublicKeyBase64Url(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  const raw = der.subarray(der.length - 32);
  return base64UrlEncode(raw);
}

let cachedDeviceIdentity: DeviceIdentity | null | undefined;

function getDeviceIdentity(): DeviceIdentity | null {
  if (cachedDeviceIdentity === undefined) {
    cachedDeviceIdentity = loadDeviceIdentity();
    if (cachedDeviceIdentity) {
      console.log(`[bolter-nats] Device identity loaded: ${cachedDeviceIdentity.deviceId.slice(0, 16)}...`);
    } else {
      console.warn('[bolter-nats] No device identity found — scopes may be limited');
    }
  }
  return cachedDeviceIdentity;
}

interface StreamForwarder {
  nc: NatsConnection;
  groupId: string;
  animaName: string;
}

/**
 * Send a message to the OpenClaw agent via the WebSocket RPC gateway.
 * Uses protocol v3 with the `agent` method and device identity for auth.
 * This is OpenClaw-specific — other claws use different dispatch mechanisms.
 * No hard timeout — OpenClaw manages agent lifecycle natively.
 * The agent runs until done (could be seconds or hours for CI tasks).
 */
async function dispatchToAgent(
  message: string,
  gatewayPort: number,
  authToken: string,
  streamForwarder?: StreamForwarder,
): Promise<string | null> {
  const device = getDeviceIdentity();

  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://[::1]:${gatewayPort}/ws`);
    const connectId = 'c-' + Date.now();
    const agentId = 'a-' + Date.now();
    let resolved = false;
    let streamedText = '';
    let chatText = '';       // Text from chat final events (backup for streamedText)
    let toolCallCount = 0;   // Track whether agent used tools
    let lastStreamPublish = 0;
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let currentToolName = 'unknown';

    const clearHeartbeat = () => {
      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    };

    const publishStream = (data: Record<string, unknown>) => {
      if (!streamForwarder) return;
      const subject = `group.${streamForwarder.groupId}.agent_stream`;
      streamForwarder.nc.publish(subject, sc.encode(JSON.stringify({
        ...data,
        animaName: streamForwarder.animaName,
        timestamp: Date.now(),
      })));
    };

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearHeartbeat();
      try { ws.close(); } catch {}
      resolve(result);
    };

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Log all gateway events for debugging
        if (msg.type === 'event') {
          console.log(`[bolter-nats] Gateway event: ${msg.event}`, msg.payload?.stream || '', JSON.stringify(msg).slice(0, 200));
        }

        // Track streamed assistant text (cumulative — last value is the full text)
        // Text lives at payload.data.text (not payload.text)
        if (msg.type === 'event' && msg.event === 'agent' && msg.payload?.stream === 'assistant') {
          const text = msg.payload?.data?.text;
          if (typeof text === 'string') {
            streamedText = text;
            // Assistant text means tool finished — clear heartbeat
            clearHeartbeat();
            const now = Date.now();
            if (now - lastStreamPublish > 500) {
              lastStreamPublish = now;
              publishStream({ type: 'text_chunk', text: streamedText });
            }
          }
        }

        // Track chat event text as backup (captures full message content from final event)
        if (msg.type === 'event' && msg.event === 'chat' && msg.payload?.state === 'final') {
          const content = msg.payload?.message?.content;
          if (Array.isArray(content)) {
            const textBlock = content.find((b: { type: string; text?: string }) =>
              b.type === 'text' && typeof b.text === 'string' && b.text.length > 0
            );
            if (textBlock && typeof textBlock.text === 'string') {
              chatText = textBlock.text;
            }
          }
        }

        // Forward tool use events — tool name at payload.data.name
        // Start heartbeat interval to keep frontend alive during long-running tool execution
        if (msg.type === 'event' && msg.event === 'agent' && msg.payload?.stream === 'tool_use') {
          toolCallCount++;
          currentToolName = msg.payload?.data?.name || msg.payload?.name || 'unknown';
          publishStream({ type: 'tool_use', tool: currentToolName });
          clearHeartbeat();
          heartbeatInterval = setInterval(() => {
            publishStream({ type: 'heartbeat', tool: currentToolName });
          }, 15_000);
        }

        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          const nonce = msg.payload?.nonce;
          const connectParams: Record<string, unknown> = {
            minProtocol: 3,
            maxProtocol: 3,
            client: { id: 'cli', version: '1.0.0', platform: 'linux', mode: 'cli' },
            scopes: ['operator.admin', 'operator.read', 'operator.write'],
          };

          if (device && nonce) {
            const signedAtMs = Date.now();
            const scopes = connectParams.scopes as string[];
            const client = connectParams.client as { id: string; mode: string };
            const payload = buildDeviceAuthPayload({
              deviceId: device.deviceId,
              clientId: client.id,
              clientMode: client.mode,
              role: 'operator',
              scopes,
              signedAtMs,
              token: authToken || '',
              nonce,
            });
            const signature = signPayload(device.privateKeyPem, payload);
            connectParams.device = {
              id: device.deviceId,
              publicKey: derivePublicKeyBase64Url(device.publicKeyPem),
              signature,
              signedAt: signedAtMs,
              nonce,
            };
          }

          if (authToken) {
            connectParams.auth = { token: authToken };
          }

          ws.send(JSON.stringify({ type: 'req', id: connectId, method: 'connect', params: connectParams }));
          return;
        }

        if (msg.type === 'res' && msg.id === connectId) {
          if (!msg.ok) {
            console.error('[bolter-nats] Gateway connect failed:', msg.error?.message);
            finish(null);
            return;
          }
          console.log('[bolter-nats] Gateway connected, dispatching agent request...');
          ws.send(JSON.stringify({
            type: 'req',
            id: agentId,
            method: 'agent',
            params: {
              message,
              agentId: 'main',
              idempotencyKey: 'nats-' + Date.now() + '-' + Math.random().toString(36).slice(2),
              deliver: false,
            },
          }));
          return;
        }

        if (msg.type === 'res' && msg.id === agentId) {
          if (msg.ok && msg.payload?.status === 'accepted') {
            console.log('[bolter-nats] Agent request accepted, waiting for completion...');
            return;
          }
          if (msg.ok && msg.payload) {
            const result = msg.payload.result ?? msg.payload;
            const payloads = result?.payloads;
            const payloadText = (Array.isArray(payloads) && payloads[0]?.text) || '';
            const resultText = result?.text ?? result?.reply ?? result?.content ?? '';
            const candidates = [streamedText, chatText, payloadText, resultText].filter(
              (t): t is string => typeof t === 'string' && t.length > 0
            );
            const text = candidates.length > 0
              ? candidates.reduce((a, b) => a.length >= b.length ? a : b)
              : null;
            if (typeof text === 'string' && text.length > 0) {
              console.log('[bolter-nats] Agent response:', text.slice(0, 200));
              finish(text);
            } else {
              const usage = result?.meta?.agentMeta?.usage;
              const outputTokens = usage?.output ?? 0;
              console.warn(
                `[bolter-nats] Agent completed without text output` +
                ` (tools=${toolCallCount}, outputTokens=${outputTokens}):`,
                JSON.stringify(msg.payload).slice(0, 500),
              );
              finish(null);
            }
          } else {
            console.error('[bolter-nats] Agent request failed:', msg.error?.message);
            finish(null);
          }
          return;
        }
      } catch (err) {
        console.error('[bolter-nats] WS message parse error:', err);
      }
    });

    ws.on('error', (err: Error) => {
      console.error('[bolter-nats] WS error:', err.message);
      finish(null);
    });

    ws.on('close', () => {
      finish(null);
    });
  });
}

/**
 * ChannelPlugin implementation for Bolter NATS.
 * Connects OpenClaw to the NATS message bus.
 * Uses shared processInboxMessage from @bolter2/anima-core for gating/classification,
 * but keeps OpenClaw-specific dispatch (WebSocket RPC v3 + device identity).
 */
export class BolterNatsChannel {
  private nc: NatsConnection | null = null;
  private inboxSub: Subscription | null = null;
  private cronSub: Subscription | null = null;
  private contextUpdateSub: Subscription | null = null;
  private animaId: string = '';
  private animaName: string = '';
  private hostedGroupIds: string[] = [];
  private groupContexts: Map<string, GroupContext> = new Map();
  private gatewayPort: number = 18789;
  private authToken: string = '';

  get id() { return 'bolter-nats'; }
  get name() { return 'Bolter NATS'; }
  get description() { return 'NATS message bus channel for Bolter platform'; }

  meta = {
    label: 'Bolter NATS',
    order: 999,
    showConfigured: false,
  };

  config = {
    listAccountIds: (_cfg: any) => ['default'],
    resolveAccount: (_cfg: any, _accountId: string) => ({
      natsUrl: process.env.NATS_URL || 'nats://localhost:4222',
      animaId: process.env.ANIMA_ID || '',
      animaName: process.env.ANIMA_NAME || 'Anima',
      enabled: true,
    }),
    isEnabled: (account: any) => Boolean(account?.enabled),
  };

  gateway = {
    startAccount: async (ctx: any) => {
      const { account, cfg } = ctx;
      this.animaId = account.animaId;
      this.animaName = account.animaName;

      this.gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT) || cfg?.gateway?.port || 18789;
      this.authToken = cfg?.gateway?.auth?.token || '';

      this.nc = await connect({
        servers: account.natsUrl,
        name: `anima-${this.animaId}`,
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 5_000,
      });

      console.log(`[bolter-nats] Connected to ${account.natsUrl} as ${this.animaName}`);

      // Fetch initial context using shared code
      const ctxResult = await fetchAnimaContext(this.animaId, this.groupContexts);
      this.hostedGroupIds = ctxResult.hostedGroupIds;

      // Helper to create all subscriptions
      const subscribe = () => {
        const contextSubject = `anima.${this.animaId}.context_update`;
        this.contextUpdateSub = this.nc!.subscribe(contextSubject);
        console.log(`[bolter-nats] Subscribed to ${contextSubject}`);

        const inboxSubject = `anima.${this.animaId}.inbox`;
        this.inboxSub = this.nc!.subscribe(inboxSubject);
        console.log(`[bolter-nats] Subscribed to ${inboxSubject}`);

        const cronSubject = `anima.${this.animaId}.cron`;
        this.cronSub = this.nc!.subscribe(cronSubject);
        console.log(`[bolter-nats] Subscribed to ${cronSubject}`);
      };

      // Initial subscription
      subscribe();

      // Re-subscribe on NATS reconnect (subscriptions go stale after disconnect)
      // The while(true) loops in processInbox/processCron/processContextUpdates
      // auto-restart when the old subscription ends, so we just swap the sub objects.
      (async () => {
        for await (const s of this.nc!.status()) {
          if (s.type === 'reconnect') {
            console.log('[bolter-nats] NATS reconnected, re-subscribing...');
            // Unsubscribe stale subs — causes the active for-await loops to exit
            this.inboxSub?.unsubscribe();
            this.cronSub?.unsubscribe();
            this.contextUpdateSub?.unsubscribe();
            // Re-create subscriptions — the while(true) wrappers pick these up
            subscribe();
            // DO NOT restart processInbox/processCron/processContextUpdates — they auto-restart
            // Re-fetch context in case it changed during disconnect
            fetchAnimaContext(this.animaId, this.groupContexts).catch(err =>
              console.error('[bolter-nats] Failed to refresh context after reconnect:', err)
            );
          }
        }
      })();

      this.nc.publish(
        'system.anima.started',
        sc.encode(JSON.stringify({
          animaId: this.animaId,
          animaName: this.animaName,
          hostedGroupIds: this.hostedGroupIds,
          timestamp: new Date().toISOString(),
        })),
      );

      console.log(`[bolter-nats] Channel started with ${this.hostedGroupIds.length} hosted groups, awaiting messages...`);

      await Promise.all([
        this.processInbox(),
        this.processCron(),
        this.processContextUpdates(),
      ]);
    },

    stopAccount: async () => {
      if (this.inboxSub) this.inboxSub.unsubscribe();
      if (this.cronSub) this.cronSub.unsubscribe();
      if (this.contextUpdateSub) this.contextUpdateSub.unsubscribe();

      if (this.nc) {
        this.nc.publish(
          'system.anima.stopped',
          sc.encode(JSON.stringify({
            animaId: this.animaId,
            timestamp: new Date().toISOString(),
          })),
        );
        await this.nc.drain();
        this.nc = null;
      }
    },
  };

  outbound = {
    sendText: async (ctx: any) => {
      if (!this.nc) throw new Error('NATS not connected');

      const outboxSubject = `anima.${this.animaId}.outbox`;
      const payload = {
        senderId: this.animaId,
        senderType: 'anima',
        senderName: this.animaName,
        groupId: getCurrentGroupId(),
        type: 'text',
        content: ctx.text || ctx.content || '',
      };

      this.nc.publish(outboxSubject, sc.encode(JSON.stringify(payload)));
    },
  };

  private publishResponse(content: string, groupId: string) {
    if (!this.nc) return;

    const outboxSubject = `anima.${this.animaId}.outbox`;
    const payload = {
      senderId: this.animaId,
      senderType: 'anima',
      senderName: this.animaName,
      groupId,
      type: 'text',
      content,
    };
    try {
      this.nc.publish(outboxSubject, sc.encode(JSON.stringify(payload)));
    } catch (err) {
      console.error(`[bolter-nats] Failed to publish response (${content.length} chars):`, err);
      // Truncate and retry — NATS maxPayload is typically 1MB
      const truncated = content.slice(0, 50_000) + '\n\n[Response truncated due to length]';
      try {
        payload.content = truncated;
        this.nc.publish(outboxSubject, sc.encode(JSON.stringify(payload)));
      } catch (retryErr) {
        console.error(`[bolter-nats] Truncated publish also failed:`, retryErr);
      }
    }
  }

  /** Reply to a DM — sends response back to the sender's inbox, not to any group */
  private publishDmReply(content: string, targetAnimaId: string) {
    if (!this.nc) return;
    const inboxSubject = `anima.${targetAnimaId}.inbox`;
    const payload = {
      senderId: this.animaId,
      senderType: 'anima',
      senderName: this.animaName,
      type: 'text',
      content,
      source: 'direct_message',
      sourceAnimaId: this.animaId,
      sourceAnimaName: this.animaName,
    };
    try {
      this.nc.publish(inboxSubject, sc.encode(JSON.stringify(payload)));
      console.log(`[bolter-nats] DM reply sent to anima ${targetAnimaId} (${content.length} chars)`);
    } catch (err) {
      console.error(`[bolter-nats] Failed to publish DM reply (${content.length} chars):`, err);
      const truncated = content.slice(0, 50_000) + '\n\n[Response truncated due to length]';
      try {
        payload.content = truncated;
        this.nc.publish(inboxSubject, sc.encode(JSON.stringify(payload)));
      } catch (retryErr) {
        console.error(`[bolter-nats] Truncated DM reply also failed:`, retryErr);
      }
    }
  }

  /** Process live context updates (group added/removed/changed) */
  private async processContextUpdates() {
    while (true) {
      if (!this.contextUpdateSub) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      let updateCount = 0;
      try {
        for await (const msg of this.contextUpdateSub) {
          updateCount++;
          try {
            const data = JSON.parse(sc.decode(msg.data));
            console.log(`[bolter-nats] Context update received:`, JSON.stringify(data).slice(0, 200));

            if (data.groups) {
              this.groupContexts.clear();
              this.hostedGroupIds = [];
              for (const g of data.groups) {
                const id = (g.groupId || g.id) as string;
                this.groupContexts.set(id, {
                  id,
                  name: (g.name as string) || '',
                  participants: (g.participants as GroupContext['participants']) || [],
                });
                this.hostedGroupIds.push(id);
              }
              console.log(`[bolter-nats] Updated context: ${this.hostedGroupIds.length} groups [${this.hostedGroupIds.join(', ')}]`);
            } else if (data.action === 'group_created' || data.action === 'group_removed'
              || data.type === 'engagement_updated' || data.type === 'personality_updated') {
              // Re-fetch full context when groups or engagement/personality change
              const prevCount = this.hostedGroupIds.length;
              const result = await fetchAnimaContext(this.animaId, this.groupContexts);
              this.hostedGroupIds = result.hostedGroupIds;
              console.log(`[bolter-nats] Context refreshed: ${this.hostedGroupIds.length} hosted groups (was ${prevCount})`);
              // Retry once if we unexpectedly lost all groups — transient RPC issue
              if (this.hostedGroupIds.length === 0 && prevCount > 0) {
                console.warn(`[bolter-nats] Lost all hosted groups — retrying context fetch in 2s...`);
                await new Promise(r => setTimeout(r, 2000));
                const retry = await fetchAnimaContext(this.animaId, this.groupContexts);
                this.hostedGroupIds = retry.hostedGroupIds;
                console.log(`[bolter-nats] Context retry: ${this.hostedGroupIds.length} hosted groups`);
              }
            }
          } catch (err) {
            console.error('[bolter-nats] Error processing context update:', err);
          }
        }
      } catch (err) {
        console.error(`[bolter-nats] Context update loop error after ${updateCount} updates:`, err);
      }
      console.warn(`[bolter-nats] Context update subscription ended after ${updateCount} updates, restarting in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  private async processInbox() {
    while (true) {
      if (!this.inboxSub) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      let messageCount = 0;
      try {
      for await (const msg of this.inboxSub) {
        messageCount++;
        try {
          const data = JSON.parse(sc.decode(msg.data));

        const handlerConfig: InboxHandlerConfig = {
          animaId: this.animaId,
          animaName: this.animaName,
          ownerId: process.env.OWNER_ID,
          hostedGroupIds: this.hostedGroupIds,
          groupContexts: this.groupContexts,
          nc: this.nc,
        };
        const prepared = await processInboxMessage(data, handlerConfig);

        if (!prepared) {
          console.log(`[bolter-nats] Skipped inbox #${messageCount}`);
          continue;
        }

        const { enrichedContent, groupId, isDm, dmReplyAnimaId } = prepared;

        const dispatchStart = Date.now();
        console.log(`[bolter-nats] Dispatching to agent [group=${groupId}, dm=${isDm}]...`);

        // Publish structured log events to the Logs tab
        const publishLog = (level: string, message: string, meta?: Record<string, unknown>) => {
          if (!this.nc || !groupId || isDm) return;
          const subject = `group.${groupId}.agent_stream`;
          this.nc.publish(subject, sc.encode(JSON.stringify({
            type: 'claw_log', level, message, meta,
            animaName: this.animaName, timestamp: Date.now(),
          })));
        };
        publishLog('info', 'Dispatching to claw', { isDm });
        // Publish "thinking" event (skip for DMs — no group to publish to)
        if (!isDm && groupId && this.nc) {
          const streamSubject = `group.${groupId}.agent_stream`;
          this.nc.publish(streamSubject, sc.encode(JSON.stringify({
            type: 'thinking',
            animaName: this.animaName,
            timestamp: Date.now(),
          })));
        }

        const effectiveGroupId = isDm ? '' : groupId;
        const forwarder: StreamForwarder | undefined = (this.nc && !isDm && groupId)
          ? { nc: this.nc, groupId, animaName: this.animaName }
          : undefined;

        // Periodic heartbeat so clients that reconnect mid-dispatch see the thinking state
        let dispatchHeartbeat: ReturnType<typeof setInterval> | undefined;
        if (!isDm && groupId && this.nc) {
          dispatchHeartbeat = setInterval(() => {
            if (!this.nc) return;
            this.nc.publish(`group.${groupId}.agent_stream`, sc.encode(JSON.stringify({
              type: 'heartbeat', animaName: this.animaName, timestamp: Date.now(),
            })));
          }, 10_000);
        }

        // Non-blocking concurrent dispatch (max 3) — each dispatch runs in its own
        // AsyncLocalStorage context so getCurrentGroupId() returns the correct
        // groupId even when multiple dispatches run in parallel.
        const replyRef = msg.reply;
        dispatchSemaphore.acquire().then(() =>
          runInDispatchContext(effectiveGroupId, () =>
            dispatchToAgent(enrichedContent, this.gatewayPort, this.authToken, forwarder)
          )
        )
          .then((responseText: string | null) => {
            const dispatchMs = Date.now() - dispatchStart;

            publishTokenEstimate(this.nc, this.animaId, enrichedContent, responseText, 'message');
            const estIn = Math.round(enrichedContent.length / 4);
            const estOut = responseText ? Math.round(responseText.length / 4) : 0;
            publishLog('info', `Tokens: in~${estIn} out~${estOut}`, { inputTokens: estIn, outputTokens: estOut, durationMs: dispatchMs });

            if (responseText) {
              console.log(`[bolter-nats] Agent responded in ${dispatchMs}ms: ${responseText.slice(0, 200)}`);
              publishLog('info', 'Response received', { durationMs: dispatchMs, length: responseText.length });
              if (dmReplyAnimaId) {
                this.publishDmReply(responseText, dmReplyAnimaId);
              } else {
                this.publishResponse(responseText, groupId);
              }
              maybeRecordInteraction(data, this.animaId);
            } else {
              console.warn(`[bolter-nats] Agent completed without text response (${dispatchMs}ms) [group=${groupId || 'dm'}, dm=${!!dmReplyAnimaId}]`);
              publishLog('info', 'Finished (tools only)', { durationMs: dispatchMs });
            }
            if (replyRef && responseText) {
              msg.respond(sc.encode(JSON.stringify({ content: responseText, groupId })));
            }
          })
          .catch((err: unknown) => {
            console.error(`[bolter-nats] Agent dispatch error [group=${groupId}]:`, err);
            publishLog('error', 'Dispatch error', { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
            const errorMsg = `I encountered an error processing your message. Please try again.`;
            if (dmReplyAnimaId) {
              this.publishDmReply(errorMsg, dmReplyAnimaId);
            } else {
              this.publishResponse(errorMsg, groupId);
            }
          })
          .finally(() => {
            clearInterval(dispatchHeartbeat);
            dispatchSemaphore.release();
            // Always clear the thinking indicator so it doesn't linger for 60s
            if (!isDm && groupId && this.nc) {
              const streamSubject = `group.${groupId}.agent_stream`;
              this.nc.publish(streamSubject, sc.encode(JSON.stringify({
                type: 'done',
                animaName: this.animaName,
                timestamp: Date.now(),
              })));
            }
          });
        } catch (err) {
          console.error(`[bolter-nats] Error processing inbox message #${messageCount}:`, err);
        }
      }
      } catch (err) {
        console.error(`[bolter-nats] Inbox loop error after ${messageCount} msgs:`, err);
      }
      console.warn(`[bolter-nats] Inbox subscription ended after ${messageCount} messages, restarting in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  private async processCron() {
    while (true) {
      if (!this.cronSub) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      let cronCount = 0;
      try {
        for await (const msg of this.cronSub) {
          cronCount++;
          try {
            const data = JSON.parse(sc.decode(msg.data));
            const description = data.description ?? 'Scheduled task triggered';
            const groupId = (data.groupId as string) || this.hostedGroupIds[0] || '';
            console.log(`[bolter-nats] Cron trigger [group=${groupId}]: ${description}`);

            let cronContent = `[Scheduled Task]\nDescription: ${description}\nTask ID: ${data.taskId || 'unknown'}\nGroup: ${groupId}\n`;
            if (data.payload && typeof data.payload === 'object' && Object.keys(data.payload).length > 0) {
              cronContent += `\nPayload:\n\`\`\`json\n${JSON.stringify(data.payload, null, 2)}\n\`\`\`\n`;
            }
            cronContent += `\nThis task was triggered automatically. Execute the planned action.`;
            const contextPrefix = buildContextPrefix(groupId, this.groupContexts, this.hostedGroupIds);
            const enrichedCronContent = `${contextPrefix}${cronContent}`;
            const forwarder: StreamForwarder | undefined = this.nc
              ? { nc: this.nc, groupId, animaName: this.animaName }
              : undefined;

            // Non-blocking concurrent dispatch (max 3) with per-dispatch context
            dispatchSemaphore.acquire().then(() =>
              runInDispatchContext(groupId, () =>
                dispatchToAgent(enrichedCronContent, this.gatewayPort, this.authToken, forwarder)
              )
            )
              .then((responseText: string | null) => {
                if (responseText) {
                  this.publishResponse(responseText, groupId);
                }
              })
              .catch((err: unknown) => {
                console.error(`[bolter-nats] Cron dispatch error [group=${groupId}]:`, err);
                this.publishResponse(
                  `I encountered an error processing a scheduled task. Please check my settings.`,
                  groupId,
                );
              })
              .finally(() => { dispatchSemaphore.release(); });
          } catch (err) {
            console.error(`[bolter-nats] Error processing cron:`, err);
          }
        }
      } catch (err) {
        console.error(`[bolter-nats] Cron loop error after ${cronCount} triggers:`, err);
      }
      console.warn(`[bolter-nats] Cron subscription ended after ${cronCount} triggers, restarting in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
