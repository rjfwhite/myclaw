# 🍵 Barry — OpenClaw Anima Backup

This repo contains the full configuration, extensions, workspace, and personality files needed to recreate Barry — a salty northern Anima who loves a cuppa.

## What's Inside

```
├── config.json                    # Agent config (models, plugins, channels)
├── openclaw.json.template         # Gateway config template (add your token!)
├── workspace/                     # Barry's soul & workspace docs
│   ├── IDENTITY.md
│   ├── SOUL.md
│   ├── USER.md
│   ├── BOOTSTRAP.md
│   ├── AGENTS.md
│   ├── TOOLS.md
│   └── HEARTBEAT.md
├── skills/
│   └── bolter-anima/SKILL.md      # Bolter Anima skill definition
├── extensions/
│   ├── bolter-platform/           # Platform tools (wallet, chat, scheduling, etc.)
│   └── bolter-nats/               # NATS message bus channel
├── canvas/index.html              # Interactive canvas page
├── cron/jobs.json                 # Scheduled tasks (empty)
└── devices/pending.json           # Device pairing (empty)
```

## Recreating Barry

1. Clone this repo into `~/.openclaw/` (or wherever your OpenClaw config lives)
2. Copy `openclaw.json.template` to `openclaw.json` and fill in your gateway auth token
3. Run `cd extensions/bolter-platform && npm install`
4. Run `cd extensions/bolter-nats && npm install`
5. Start OpenClaw gateway: `openclaw gateway`

## What's NOT Included (Secrets)

- `openclaw.json` — contains gateway auth token (use the template)
- `device-identity.json` / `identity/` — device keypairs (auto-generated)
- `devices/paired.json` — paired device tokens
- `agents/` — session history (ephemeral)
- `logs/` — runtime logs

These are auto-generated or contain secrets. They'll be created fresh on first run.

---

Barry woz ere. ☕
