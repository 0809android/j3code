# K3 Code

> **K3 Code** is a fork of [T3 Code](https://github.com/pingdotgg/t3code) maintained by [Kinocode](https://kinocode.jp). It is not affiliated with or endorsed by T3 Tools Inc. T3 Code is MIT licensed; the original copyright notice is kept in [LICENSE](./LICENSE).

K3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, K3 Code can control it.

## What you get

- **Your subscriptions.** K3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [remote access](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Japanese by default.** The first screen has an English-labelled language switcher, and the app starts in Japanese.
- **Side by side with T3 Code.** K3 Code keeps its data in `~/.k3code` and never touches `~/.t3`. It can read your T3 Code settings, providers and history on first launch, or any time from Settings.

## Install

K3 Code has no packaged releases yet. Build it from source with the [development runbook](./docs/operations/00_development.md#first-checkout). Releases will appear on [GitHub Releases](https://github.com/kinocode-jp/k3code/releases).

K3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`. [Provider setup](./docs/user/install.md#providers) has the steps for each agent.

## Coming from T3 Code

Your T3 Code data stays where it is. See [Importing from T3 Code](./docs/user/import-from-t3-code.md) for what is copied and how session history is brought over.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Importing from T3 Code](./docs/user/import-from-t3-code.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list. The [architecture overview](./docs/internals/01_architecture.md) explains how it works.

## Contributing

Open an issue or pull request on [kinocode-jp/k3code](https://github.com/kinocode-jp/k3code). Read [CONTRIBUTING.md](./CONTRIBUTING.md) first.

## License

[MIT](./LICENSE). K3 Code is based on T3 Code, © T3 Tools Inc.
