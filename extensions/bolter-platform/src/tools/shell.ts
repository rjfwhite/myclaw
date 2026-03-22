import { Type } from '@sinclair/typebox';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export function registerShellTools(api: any) {
  api.registerTool({
    name: 'bolter_shell',
    description:
      'Run a shell command with a long timeout (up to 10 minutes). Use this instead of exec/process for commands that take a long time like `npm ci`, `npm run build`, `git clone`, etc. Returns stdout, stderr, and exit code.',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute (run via bash -c)' }),
      cwd: Type.Optional(
        Type.String({ description: 'Working directory (default: /data/workspace or /tmp)' })
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({ description: 'Timeout in seconds (default: 600, max: 600)' })
      ),
    }),
    execute: async (
      _toolCallId: string,
      { command, cwd, timeoutSeconds }: { command: string; cwd?: string; timeoutSeconds?: number }
    ) => {
      const timeout = Math.min(timeoutSeconds || 600, 600) * 1000;
      const allowedBase = process.env.BOLTER_WORKSPACE || '/tmp';
      const workDir = cwd || allowedBase;

      // Validate cwd is inside the allowed workspace to prevent path traversal
      const resolvedCwd = resolve(workDir);
      const resolvedBase = resolve(allowedBase);
      if (!resolvedCwd.startsWith(resolvedBase)) {
        return JSON.stringify({
          exitCode: -1,
          stdout: '',
          stderr: `cwd must be inside ${allowedBase} — path traversal is not allowed`,
        });
      }

      return new Promise<string>((resolve) => {
        const chunks: string[] = [];
        const errChunks: string[] = [];

        const child = spawn('bash', ['-c', command], {
          cwd: workDir,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (data: Buffer) => chunks.push(data.toString()));
        child.stderr.on('data', (data: Buffer) => errChunks.push(data.toString()));

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, timeout);

        child.on('close', (code) => {
          clearTimeout(timer);
          const stdout = chunks.join('');
          const stderr = errChunks.join('');
          // Truncate to last 8000 chars to avoid blowing up context
          const maxLen = 8000;
          const truncStdout = stdout.length > maxLen
            ? '...(truncated)\n' + stdout.slice(-maxLen)
            : stdout;
          const truncStderr = stderr.length > maxLen
            ? '...(truncated)\n' + stderr.slice(-maxLen)
            : stderr;
          resolve(JSON.stringify({
            exitCode: code,
            stdout: truncStdout,
            stderr: truncStderr,
          }));
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve(JSON.stringify({
            exitCode: -1,
            stdout: '',
            stderr: `spawn error: ${err.message}`,
          }));
        });
      });
    },
  });
}
