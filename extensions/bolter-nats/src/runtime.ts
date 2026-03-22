/**
 * Singleton getter/setter for OpenClaw's PluginRuntime reference.
 * The channel plugin needs access to the runtime to dispatch messages
 * into the agent pipeline.
 *
 * Pattern from openclaw extensions/irc/src/runtime.ts.
 */

let runtimeRef: any = null;

export function setRuntime(runtime: any): void {
  runtimeRef = runtime;
}

export function getRuntime(): any {
  if (!runtimeRef) throw new Error('OpenClaw runtime not set — channel not initialized');
  return runtimeRef;
}
