# Importing from T3 Code

J3 Code keeps its data in `~/.j3code`, apart from a T3 Code install's `~/.t3`. When both exist on
the same computer, J3 Code can bring over what you choose. Your T3 Code data is only read, never
changed.

On first launch a window offers the import. Later, use **Settings → General → Import** and
**Choose what to import**.

- **Settings and keyboard shortcuts:** appearance, preferences, and keybindings. Sign-ins,
  microphones, browser profiles, and anything tied to a project or device stay behind. Your
  current keybindings are saved as `keybindings.json.before-import` first.
- **Provider settings:** the provider instances you set up. Credentials kept in T3 Code's secret
  store are not copied; sign in again where a provider asks.
- **Sessions and history:** all threads and their attachments. This replaces the history in J3 Code
  and takes effect after a restart. The history it replaces stays beside the database as
  `statev2.sqlite.before-import-<time>`. Importing again later replaces the history again.

An import can fail when the T3 Code data is newer than J3 Code; update J3 Code first.
