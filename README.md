# localhosting:3000

Undo button for localhost. Automatic snapshots when your local app is actually serving a good state. One-click restore of the last good local tree. Nothing leaves this machine.

Not git. Not Vercel rollback. Not a port killer.

You do not remember to snapshot. The watcher does.

MIT, npx, local folder `.localhosting/`.

## Install

Requires Node.js 20.10 or later.

```bash
npx localhosting watch
```

Or from this package:

```bash
npm install
npm run build
node dist/cli.js --help
```

Leave `localhosting watch` running while your app is on localhost (usually `:3000`). The dashboard is on `:3001` because `:3000` is already taken by your app.

```bash
npx localhosting list
npx localhosting restore <id>
```

Restore writes files; restart your dev server. We do not kill processes.

## How to verify no network

v1 is loopback only. There is no telemetry, no accounts, and no `postinstall` script.

1. Confirm there is no postinstall: `npm pkg get scripts.postinstall` prints `{}`.
2. The process may listen on `127.0.0.1:3001` through `3010` and may GET the configured loopback probe URL (default `http://127.0.0.1:3000/`). That is the entire network surface.
3. Automated tests spy on `fetch` / `http.request` during `snapshot` and expect zero outbound connections.

## Commands

`init`, `watch`, `serve`, `snapshot`, `list`, `restore`, `pin`, `unpin`, `prune`, `status`

## Limitations

localhosting:3000 does **not** promise:

1. Durability beyond this disk. The store is files in `.localhosting/`. If the disk dies, the snapshots die.
2. A snapshot of files it ignored (by default: `node_modules`, `.git`, build artifacts, most gitignored paths).
3. A snapshot during a stretch where the detector never saw a good state (overlay stayed up, probe URL down, settle never happened).
4. Preservation of in-memory dev-server state, HMR runtime, cookies, or browser tabs.
5. Cross-machine restore, encryption-at-rest beyond OS permissions, or multi-user locking beyond a pid lockfile.
6. That the latest snapshot is the user's *favorite* state. It is the latest *detector-good* state. Pin exists for favorites.
7. Database undo (Postgres, SQLite files that were gitignored, Redis).
8. That a restore will succeed on every open file while another process holds a Windows lock. Partial restore is a specified outcome (exit 4).

git is not involved. We do not touch the index. Restored files may appear as git diffs. That is correct.

Do not give an agent `localhosting restore --yes` in a skill file. Dashboard restore always confirms.

## Not a port dashboard

We do not scan your ports. We do not kill processes. Discovering a free bind port for our own dashboard (3001 then 3002-3010) is bind-and-retry, not a scanner UI.

## FAQ

**Why not just use git?**
You would. You did not. The agent did not either. This watches the running app, not your conscience.

**Is this a production rollback tool?**
No. Production already has Netlify and Vercel. This is for the three hours before you deploy, when :3000 is on fire and there is no commit.

**Will this replace Time Machine / uhoh / local history?**
No. Those snapshot writes. We snapshot good running states. Different trigger, smaller history, on purpose.

**Do you upload my code?**
No. v1 has no accounts and no telemetry. Snapshots live in `.localhosting/` on this disk. If the disk dies, they die.

**Can I restore without restarting the dev server?**
We write files. We do not kill processes. Restart the server. If a file was locked, restore reports partial and you retry.

**Where is the dashboard?**
:3001 by default, never :3000. :3000 is the patient, not the doctor.

## License

MIT
