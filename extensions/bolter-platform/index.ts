import { getAllTools, buildSystemPrompt, getContextData } from '@bolter2/anima-core';
import { DEFAULT_MODEL } from '@bolter2/shared';
import { registerShellTools } from './src/tools/shell.js';

export default {
  id: 'bolter-platform',
  name: 'Bolter Platform',
  description: 'Bolter platform tools and Anima identity injection',

  register(api: any) {
    // Inject Anima identity into system prompt
    api.on('before_prompt_build', () => {
      const context = getContextData();
      return {
        systemPrompt: buildSystemPrompt({
          animaId: process.env.ANIMA_ID || 'unknown',
          animaName: process.env.ANIMA_NAME || 'Anima',
          ownerId: process.env.OWNER_ID,
          ownerName: process.env.OWNER_NAME,
          orchestratorUrl: process.env.ORCHESTRATOR_URL,
          personality: process.env.ANIMA_PERSONALITY,
          context,
        }),
      };
    }, { priority: 100 });

    // Force model — reads from env (set during machine creation) or shared constant
    api.on('before_model_resolve', () => ({
      modelOverride: process.env.AI_MODEL || DEFAULT_MODEL,
      providerOverride: 'anthropic',
    }));

    // Register all Bolter-specific tools from shared package
    for (const tool of getAllTools()) {
      api.registerTool({
        ...tool,
        execute: async (_toolCallId: string, params: any) => tool.execute(params),
      });
    }

    // OpenClaw-specific shell tool (uses child_process.spawn directly — IronClaw has its own WASM sandbox)
    registerShellTools(api);
  },
};
