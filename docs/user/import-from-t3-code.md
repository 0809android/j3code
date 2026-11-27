# Importing from T3 Code

K3 Code keeps its data in `~/.k3code`, apart from a T3 Code install's `~/.t3`. When both exist on
the same computer, K3 Code can bring over what you choose. Your T3 Code data is only read, never
changed.

On first launch a window offers the import. Later, use **Settings → General → Import** and
**Choose what to import**.

- **Settings and keyboard shortcuts:** appearance, preferences, and keybindings. Sign-ins,
  microphones, browser profiles, and anything tied to a project or device stay behind. Your
  current keybindings are saved as `keybindings.json.before-import` first.
- **Provider settings:** the provider instances you set up. Credentials kept in T3 Code's secret
  store are not copied; sign in again where a provider asks.
- **Sessions and history:** all threads and their attachments. This replaces the history in K3 Code
  and takes effect after a restart. The history it replaces stays beside the database as
  `statev2.sqlite.before-import-<time>`. Importing again later replaces the history again.

## Before you import sessions

- **Let running threads finish in T3 Code first.** A thread that is still working when you import
  is stopped in K3 Code after the restart instead of picking up where it left off, and work T3 Code
  had queued for it is dropped. It keeps running in T3 Code.
- **Afterwards, continue each thread in one app only.** The imported threads are copies. If you
  keep using both apps, the same thread can carry on in each, for example when a subagent's result
  arrives or a usage limit resets, and the work runs twice.
- **You stay signed in.** The desktop app's session and your paired devices are kept; T3 Code's
  are not copied.

An import can fail when the T3 Code data is newer than K3 Code; update K3 Code first.
