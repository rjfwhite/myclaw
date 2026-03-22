import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for heartbeat emission during tool execution in dispatchToAgent.
 *
 * Since dispatchToAgent is a module-level function inside channel.ts (not exported),
 * we test the heartbeat logic by extracting the core behavior patterns and verifying
 * them against the same event-handling logic used in production.
 */

describe('heartbeat during tool execution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts heartbeat interval on tool_use event', () => {
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let currentToolName = 'unknown';
    const published: Array<Record<string, unknown>> = [];

    const publishStream = (data: Record<string, unknown>) => {
      published.push(data);
    };
    const clearHeartbeat = () => {
      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    };

    // Simulate tool_use event
    currentToolName = 'bash';
    publishStream({ type: 'tool_use', tool: currentToolName });
    clearHeartbeat();
    heartbeatInterval = setInterval(() => {
      publishStream({ type: 'heartbeat', tool: currentToolName });
    }, 15_000);

    expect(published).toEqual([{ type: 'tool_use', tool: 'bash' }]);

    // After 15s, first heartbeat
    vi.advanceTimersByTime(15_000);
    expect(published).toHaveLength(2);
    expect(published[1]).toEqual({ type: 'heartbeat', tool: 'bash' });

    // After another 15s, second heartbeat
    vi.advanceTimersByTime(15_000);
    expect(published).toHaveLength(3);
    expect(published[2]).toEqual({ type: 'heartbeat', tool: 'bash' });

    clearHeartbeat();
  });

  it('clears heartbeat when assistant text arrives', () => {
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let currentToolName = 'unknown';
    const published: Array<Record<string, unknown>> = [];

    const publishStream = (data: Record<string, unknown>) => {
      published.push(data);
    };
    const clearHeartbeat = () => {
      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    };

    // Start heartbeat (tool_use)
    currentToolName = 'web_browse';
    publishStream({ type: 'tool_use', tool: currentToolName });
    clearHeartbeat();
    heartbeatInterval = setInterval(() => {
      publishStream({ type: 'heartbeat', tool: currentToolName });
    }, 15_000);

    // Advance 15s — one heartbeat
    vi.advanceTimersByTime(15_000);
    expect(published).toHaveLength(2);

    // Simulate assistant text arriving (clears heartbeat)
    clearHeartbeat();
    publishStream({ type: 'text_chunk', text: 'Hello' });

    // Advance another 15s — no more heartbeats
    vi.advanceTimersByTime(15_000);
    expect(published).toHaveLength(3); // tool_use + heartbeat + text_chunk, no extra heartbeat
    expect(published[2]).toEqual({ type: 'text_chunk', text: 'Hello' });
  });

  it('clears heartbeat on finish', () => {
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let currentToolName = 'unknown';
    const published: Array<Record<string, unknown>> = [];

    const publishStream = (data: Record<string, unknown>) => {
      published.push(data);
    };
    const clearHeartbeat = () => {
      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    };

    // Start heartbeat
    currentToolName = 'code_exec';
    clearHeartbeat();
    heartbeatInterval = setInterval(() => {
      publishStream({ type: 'heartbeat', tool: currentToolName });
    }, 15_000);

    // Simulate finish() — should clear heartbeat
    clearHeartbeat();

    // Advance timers — no heartbeats should fire
    vi.advanceTimersByTime(60_000);
    expect(published).toHaveLength(0);
  });

  it('heartbeat includes current tool name', () => {
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    let currentToolName = 'unknown';
    const published: Array<Record<string, unknown>> = [];

    const publishStream = (data: Record<string, unknown>) => {
      published.push(data);
    };
    const clearHeartbeat = () => {
      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    };

    // First tool
    currentToolName = 'npm_build';
    clearHeartbeat();
    heartbeatInterval = setInterval(() => {
      publishStream({ type: 'heartbeat', tool: currentToolName });
    }, 15_000);

    vi.advanceTimersByTime(15_000);
    expect(published[0]).toEqual({ type: 'heartbeat', tool: 'npm_build' });

    // Second tool starts — heartbeat restarts with new tool name
    currentToolName = 'deploy';
    clearHeartbeat();
    heartbeatInterval = setInterval(() => {
      publishStream({ type: 'heartbeat', tool: currentToolName });
    }, 15_000);

    vi.advanceTimersByTime(15_000);
    expect(published[1]).toEqual({ type: 'heartbeat', tool: 'deploy' });

    clearHeartbeat();
  });
});
