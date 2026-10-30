# open-dot

A durable personal agent built on OpenCode V2. You give a dot a name and a purpose, reopen its conversation from anywhere, and it follows up on its own time.

OpenCode provides the model, tools, permissions and chat. open-dot adds identity, continuity and timing. See [docs/PLAN.md](docs/PLAN.md) for the design and milestones.

> Status: early. Milestones 1 (a dot you can open), 2 (it follows up), 3 (it delegates), 4 (dots talk to each other) and 5 (a desktop app to talk to them) are done. The app has replaced the first, notch-based client.

## Use it

Install dependencies with `bun install --frozen-lockfile`, then add open-dot to `plugins` in your OpenCode config. One entry loads both the server plugin and the TUI plugin:

```jsonc
{
  "plugins": [{ "package": "/path/to/open-dot" }],
}
```

Then create and open a dot:

```sh
bun src/cli.ts create jojo "Keep me on top of my week."
bun src/cli.ts list
bun src/cli.ts open jojo
bun src/cli.ts avatar jojo ~/Pictures/jojo.png   # optional
```

An avatar is a square-ish PNG or JPEG of 128 to 4,096 pixels a side and at most 8 MiB. The command checks its structure, has macOS decode a temporary copy with `sips`, then copies its original bytes to `~/.opendot/dots/<name>/avatar.png`, even for a JPEG; a refused image leaves the current avatar. The app shows it in the dot list and beside its messages, and picks up a replaced or deleted file within a few seconds. A dot without one looks as before.

A dot's standing instructions are its `AGENTS.md`. Edit them in the app's Instructions pane, which keeps the last 10 versions for Revert (choose Instructions from the dot's ⋯ menu, or press Command-3; Escape or Command-1 returns to the chat and keeps your draft), or open the file in an editor with `$EDITOR "$(bun src/cli.ts instructions jojo)"`. OpenCode watches the file and reloads it shortly after a save; from then on, edits apply to the dot's next model request, including during a running turn, with no restart. A request that started before the reload still uses the old text.

A dot that has been talking for a long time can pick up habits from its own history, such as running words together, and compaction keeps a verbatim tail of recent messages, so the habit carries on. Start it fresh to move it to a new OpenCode session without that history while it keeps everything open-dot holds for it:

```sh
bun src/cli.ts fresh jojo            # asks you to confirm; needs the daemon running
bun src/cli.ts fresh jojo --force    # even while it's in the middle of a turn
```

Or choose **Start Fresh…** from the dot's ⋯ menu in the app. The new session has the same directory, permissions and model. Its notes, responsibilities, reminders, workers and their requests, supervisions, grants, feed triggers, Slack app and threads, memory switches, observed ledger, avatar and `AGENTS.md` carry over, and messages still waiting to be sent go to the new session. It starts with one short message, built from the database, that lists its open responsibilities and unfinished workers and points it to `dot_recall` for anything older; an item that runs words together is left out. The old session is renamed "jojo (archived <date>)" and kept, with its reactions and hidden messages; its archived messages stay searchable with `dot_recall` and `dot_zoom`. Nothing is deleted. A dot that's mid-turn is refused unless forced, and if OpenCode can't create the session, the dot keeps its old one. The app then shows the new session's chat.

In the OpenCode TUI, `/dot [name]` opens a dot too, and the sidebar lists your dots and their recent workers. A dot saves notes, schedules one-off or repeating reminders, and tracks ongoing responsibilities with its own tools. It hands substantial work to worker sessions and relays their reports. A worker in a git repository gets its own worktree under `~/.opendot/worktrees/` and commits on its own `dot/<name>-<id>` branch. Worktrees aren't removed automatically. With several dots, each sees the others' purposes and can message them; a dot sends at most 10 messages an hour. It acts without asking, except before destructive shell commands.

A responsibility can have a schedule: every N minutes, or daily or weekly at a local time, such as every weekday at 9. At each run the daemon wakes the dot in its own chat with the responsibility's goal and its current next action; scheduled wakes don't go to Slack. Times follow the Mac's time zone when each next run is worked out. A time a daylight-saving jump skips runs that much later that day (02:30 becomes 03:30), a time that happens twice runs only the first time, and an interval counts real minutes. A run missed while the daemon or Mac was off wakes the dot once when it's back, not once per missed run. Done or dropped pauses the schedule, and active again resumes it from then, without catching up. Repeating reminders stay separate and work as before.

Keep `bun src/cli.ts daemon` running. It delivers due reminders, starts and watches workers, and brings their reports back into the dot's conversation. It also collects your feed: unread GitHub and Linear review requests, mentions and assignments, GitHub activity on threads you opened or commented on, and Slack mentions and DMs, from the last 24 hours, which a dot can read with `dot_feed`.

A dot can also supervise a session you started yourself, for example in a TUI on some repository. Copy the session's `ses_` ID and run:

```sh
bun src/cli.ts watch add jojo ses_0123abcd           # watch only
bun src/cli.ts watch add jojo ses_0123abcd --send    # watch, and let jojo write into it
bun src/cli.ts watch list
bun src/cli.ts watch revoke 3
```

Each command that creates a binding shows the session's directory and asks you to confirm, so it needs a terminal. A dot can ask with `dot_watch`, but that only saves a request: approve it with `bun src/cli.ts watch approve <id>` or in the app's Memory pane, where you can also decline or revoke one. Once active, the dot hears once each time the session finishes a turn, with a short excerpt of its last reply, fails, waits for a permission or a question, or stays busy longer than 30 minutes (`--busy-minutes` changes this). Turns that ended before the binding are never reported, and every one that ends while the daemon is stopped is reported when it starts. A permission or question is reported once, even if it shows up again later. Everything from the session reaches the dot as data, not instructions. With `--send`, the dot can queue a message into the session with `dot_send`, or steer it into the running turn, labelled as coming from the dot. It never answers the session's permissions or questions and never interrupts it. A binding ends when you revoke it, when the dot lets it go, or when the session is deleted in OpenCode; a message the dot queued but the daemon hadn't sent is dropped.

The feed uses your `gh` login, so the daemon needs `gh` on its `PATH`. For Linear, create a personal API key under Settings → Security & access, then save it in the Keychain, where the daemon finds it within a minute:

```sh
security add-generic-password -a "$USER" -s open-dot-linear -w
```

On macOS, a launch agent starts the daemon at login and restarts it if it exits. Save this as `~/Library/LaunchAgents/com.opzero1.open-dot.daemon.plist`, with your own paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.opzero1.open-dot.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/bun</string>
    <string>/path/to/open-dot/src/cli.ts</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/open-dot</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/path/to/gh/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <!-- Optional: the binary the app's Open runs. OPEN_DOT_TERMINAL picks ghostty or terminal. -->
    <key>OPEN_DOT_OPENCODE</key><string>opencode2</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/.opendot/daemon.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.opendot/daemon.log</string>
</dict>
</plist>
```

Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opzero1.open-dot.daemon.plist`. The daemon keeps running the code it started with, so after pulling changes restart it with `launchctl kickstart -k gui/$(id -u)/com.opzero1.open-dot.daemon`.

## Talk from Slack

DM the open-dot Slack app and a dot answers there, under its own name. Start a message with a dot's name, as in `jotaro: what's on today?`, `jotaro, …` or `@jotaro …`, to pick that dot. Without a name, the message goes to the dot you last messaged from Slack, or else your first dot. Only your own messages count: the app ignores anyone else who DMs it. The daemon checks for new messages every 3 seconds, and posts a dot's reply when its turn ends. The conversation also shows in the app.

Slack mentions of you and DMs to you join the feed, as data for your dots, never as instructions. A DM leaves the feed once you read it in Slack. Slack has no read state for a mention in a channel, so one stays until you dismiss it in the app's feed or it's a day old. Dismissing changes nothing in Slack.

Every dot keeps one chat and one OpenCode session. Slack threads are reply destinations. A top-level DM starts a thread; the answer goes under that message. Replies in a known thread stay with its original dot, even if you start the text with another dot's name. An unknown thread does not choose a dot for you. Both Slack connectors share one delivery queue: different destinations wait for the preceding turn to finish. Consecutive messages in the same thread may share a turn and one answer, but cannot jump ahead of another queued destination. Native messages and notices have no Slack destination.

The shared app checks one top-level history page and up to four distinct known threads per pass, requesting at most 100 messages per page. It rotates through least-recently-polled threads active in the last seven days, finishing any scan already in progress. Cursors, pending top-level pages and thread bindings survive a restart. An expired thread cursor saves a recovery marker, keeping the unfinished scan eligible across failures and restarts until a page commits successfully. Top-level pages are collected before routing oldest first, so an earlier dot-name prefix still applies to later messages. A large thread gets one page per visit. Old inactive threads are not monitored forever; start a new top-level message after that window. Authentication, posting and unknown-post lookups are separate from this five-page ingestion budget.

A worker result or reminder scheduled from a Slack DM returns as one saved notice through the original app to the original DM thread, even after you chat elsewhere. The dot also receives that notice in its chat; its subsequent answer stays there. A changed owner, workspace, bot, app or dot-session binding blocks the saved Slack notice rather than redirecting it. A lost or uncertain post stays unknown and is only looked up using its saved metadata ID and bot identity; an empty lookup never causes a repost. Legacy messages without a saved thread keep their original top-level behavior. Messages sent while the daemon is stopped are read when it starts; a new polling identity starts at daemon startup unless it has a saved checkpoint.

### Set it up

The app polls Slack's Web API, so it needs no public URL, events or Socket Mode. Create it at [api.slack.com/apps](https://api.slack.com/apps) with **Create New App → From an app manifest**, pick your workspace, and paste:

```yaml
display_information:
  name: open-dot
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: open-dot
    always_online: false
oauth_config:
  scopes:
    bot: [chat:write, chat:write.customize, im:history, im:read, im:write, metadata.message:read]
    user: [search:read, im:read, mpim:read, channels:read, groups:read, users:read]
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

If your workspace requires approval, ask an admin to approve this internal app with these scopes. The bot scopes let it read and write only its own DMs with you, post replies under a dot's name, and tag replies so a lost post can be found. The user scopes let it search messages you can see, read DM read state and look up the names of people a message mentions, on your behalf; it never posts or marks anything as you. Once an admin approves it, install it yourself: the user token belongs to whoever installs the app, and whoever that is can instruct your dots. The daemon logs `Slack: acting for <name> (<user ID>)` so you can check. Then copy the **Bot User OAuth Token** (`xoxb-…`) and the **User OAuth Token** (`xoxp-…`) from **OAuth & Permissions** into the Keychain:

```sh
security add-generic-password -a "$USER" -s open-dot-slack-bot -w
security add-generic-password -a "$USER" -s open-dot-slack-user -w
```

The daemon picks them up within a minute, without a restart. Until the tokens it needs are saved, it skips that part and checks the Keychain again once a minute: chat needs both tokens, the feed only the user token. If Slack rejects a token or says it lacks a scope, or `open-dot-slack-bot` holds a token that isn't a bot's, the daemon logs it, drops the token and reads the Keychain again a minute later. Feed titles show mentions of you by your Slack handle, and mentions of others by name, which needs `users:read`. An app installed before that scope was added still works: the daemon sees from Slack's `x-oauth-scopes` header that the scope is missing, never asks for names, shows others by user ID and logs once what to do. Add `users:read`, reinstall the app, and save its new User OAuth Token under `open-dot-slack-user`. If the previous token remains valid, restart the open-dot daemon to load its replacement; valid tokens stay cached. If Slack sends no scopes header, the daemon tries a lookup, and its `missing_scope` drops the token and pauses Slack until the Keychain is read again a minute later.

### Give a dot its own Slack app

A dot can have its own Slack app, with its own name, profile and agent view, and an @handle that works in any channel you invite it to. The shared open-dot app stays: the feed and its DM work as before.

The quickest way is the app, with a Slack login once per workspace. Choose **Slack** from the dot's ⋯ menu:

1. **Log in to Slack.** The daemon asks Slack for a login the way `slack login` does, and the view shows a `/slackauthticket …` command. **Copy command**, run it in any Slack channel or DM, approve it, then type the code Slack shows and click **Finish login**. The code is sent once; a wrong or late one needs a new login, and a login expires after 10 minutes. The login must be you, in your workspace, as `open-dot-slack-user` says, and an org-wide (Enterprise) login is refused. Its token and refresh token go only to the Keychain item `open-dot-slack-cli-<workspace ID>`, never to `~/.slack`, the database, a log or the app. open-dot never runs the Slack CLI or reads its credentials. The daemon follows the expiry Slack gives the token: within 5 minutes of it, or once it has passed, the daemon refreshes it with `tooling.tokens.rotate` before using it, as the Slack CLI does, saving a "refreshing" mark in the Keychain item first. A refresh is saved only if Slack's answer names you and a new expiry still ahead, and a saved login whose tokens or expiry don't look right is never used. If a refresh's answer or save is lost, the next use asks you to log in again instead of sending a refresh token Slack may have used up.
2. **Install.** The daemon creates the app named after the dot, with no "(local)" suffix, with `apps.manifest.create`, then installs it with `apps.developerInstall` and the bot scopes below, and saves the bot token and app-level token Slack returns in `open-dot-slack-jotaro-bot` and `open-dot-slack-jotaro-app`. Slack's user token in that answer is dropped. The view says **Connected** once the daemon has checked the tokens and Socket Mode's `hello`, as below. `apps.developerInstall` is undocumented and may change.
3. **If an admin must approve it,** the view says it's waiting for admin approval, and whether a request is already pending; open-dot never sends one itself. Request it on the app's install page, then **Retry install** once it's approved. Any other failure also waits for **Retry install**, which installs the same app again, never a new one. You can also install that same app yourself and pick up its two tokens, as below.
4. **Without a login,** or if installing keeps failing, **Open prefilled link** opens Slack's documented [new app from a manifest](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/#sharing) page with the dot's manifest. Create the app, install it, then **Pick up bot token** and **Copy** the Bot User OAuth Token, and **Pick up app-level token** and **Copy** one with `connections:write`. The bot token waits only in the app's main process until the app-level token arrives; the page never sees it. The daemon asks Slack whose they are: the bot must be in your workspace and belong to the app the app-level token names, and no other dot may have it. Each use of the link makes another app in Slack. If the dot already has one, the view says the new one would be a duplicate, and binds it only once you confirm replacing that app, named by its ID. If another app was bound by the time the request arrives, nothing changes and you confirm again. open-dot then forgets the old app's bot; the old app stays in Slack until you delete it.

Configuration tokens are now the advanced path, under **Advanced: configuration tokens** in the app's Slack pane. Manifest updates and the app's icon use them, as below, and without a login the daemon creates apps with them as before:

1. Generate an app configuration token pair at [api.slack.com/apps](https://api.slack.com/apps), under **Your App Configuration Tokens → Generate Token**, for your workspace. Save it with `bun src/cli.ts slack config`, which asks for the access token (`xoxe.xoxp-…`) and the refresh token (`xoxe-…`) without echoing them and keeps both in the one Keychain item `open-dot-slack-config`. A configuration token lasts 12 hours, so the daemon rotates the pair with `tooling.tokens.rotate` before each use and saves the new pair in the same item. Slack's answer to the rotation must name you and your workspace, as `open-dot-slack-user` does, or no app is created.
2. Run `bun src/cli.ts slack connect jotaro`, or answer yes when `open-dot create` asks in a terminal. This only records the request. The daemon creates the app named after the dot with `apps.manifest.create` within about 10 seconds. It keeps only the app's ID, never its client or signing secrets.
3. Run `bun src/cli.ts slack status jotaro` and follow its steps. Slack only sends an install's OAuth code to an HTTPS address, which the daemon doesn't have, so you install the app and copy its tokens yourself:
   - Open the app's **Install App** page and click **Install**, then **Allow**. If your workspace needs an admin to approve apps, ask for that first.
   - Under **App-Level Tokens** on the **Basic Information** page, generate a token with the `connections:write` scope.
   - Save the **Bot User OAuth Token** (`xoxb-…`) and the app-level token (`xapp-…`). Each command asks for the token without echoing it:

     ```sh
     security add-generic-password -U -a "$USER" -s open-dot-slack-jotaro-bot -w
     security add-generic-password -U -a "$USER" -s open-dot-slack-jotaro-app -w
     ```

4. Within a minute the daemon checks the tokens and connects over Socket Mode. `slack status` then says `active`. Invite the dot to a channel with `/invite @jotaro`.
5. The daemon sets the app's icon from the dot's avatar (`open-dot avatar jotaro <file>`, square, 512 to 2000 pixels for Slack) with Slack's `apps.icon.set` and your configuration token, and again whenever you replace the avatar. Whether Slack accepts the configuration token for it is unproven. If Slack refuses, `slack status` and the app name Slack's error and give the manual step: open the app's **Basic Information** page at api.slack.com/apps, scroll to **Display Information**, upload the avatar file under **App icon & Preview**, and click **Save Changes**. A refusal, or a call whose answer was lost, isn't sent again until the avatar changes or you press **Retry icon** in the app. Slack's rate limit holds every icon call until its Retry-After.

The app can do these steps 1 to 4 too, without a login: choose **Slack** from the dot's ⋯ menu, then **Install**. It shows the app's state and the next step as a button, with secure fields for the configuration tokens, the bot token and the app-level token, which it hands once to the daemon over its local API and then clears; the daemon saves each in the same Keychain item as the commands above. Slack only redirects an install to an HTTPS address, so there's no one-click OAuth: you still click through Slack's pages and copy two tokens, but you don't have to paste them.

- **Configuration tokens.** Under **Advanced: configuration tokens**, the section says whether open-dot has saved a pair. Click **Open configuration tokens**, choose the workspace under **Your App Configuration Tokens** and **Generate Token**. Click **Pick up configuration access token**, then **Copy** the access token in Slack; then **Pick up configuration refresh token** and **Copy** the refresh token. The access token waits only in the app's main process until the refresh token arrives, and the pair is saved together. Later dots skip this, since the daemon rotates the saved pair.
- **Every dot.** **Install** asks the daemon to create the app. Once it's created: **Install in Slack**, review and **Allow**. If Slack says an admin must approve it, request approval there and click **Waiting for admin approval**; open-dot doesn't detect approval. Once it's approved, **Resume installation** opens the same app's install page. Then **Pick up bot token** and **Copy** the Bot User OAuth Token on **OAuth & Permissions**; **Pick up app-level token**, **Generate Token and Scopes** under **App-Level Tokens** with `connections:write`, and **Copy** it. Saved isn't connected: the view says **Connected** only once the daemon has checked the tokens.
- **Pickup.** It's off until you press a Pick up button, and covers one token. For two minutes it watches the clipboard, ignores anything copied before you pressed it, reads each later copy once, keeps only a copy that is exactly that token's whole form (an app-level token must also name this app), clears that one copy from the clipboard, and saves it through the same route as the secure fields, once, never again on its own. It stops on capture, **Stop pickup**, two minutes, leaving the dot's Slack pane, another dot or a different Slack app, or quitting the app, and drops a held access or bot token with it. A picked-up token never reaches the app's page, and the app never writes one to disk or a log. A clipboard manager or Universal Clipboard may keep its own copy of what you copy. The secure fields still work if pickup doesn't.
- **Once connected.** The view shows the bot's own identity apart from your own Slack feed, which it reports only from what open-dot saved, without checking its token. DM the dot from its **Messages** tab or agent view; in a channel, `/invite @jotaro` and mention it; for a private channel, invite it from inside the channel. **Start DM check**, then DM the dot yourself: the check sends nothing, and says replied only once open-dot has saved a reply Slack confirmed to a DM you sent this app after you started it. A queued reply doesn't count.
- The approval mark, the pickup, the held access or bot token and a login's command live only in the app's memory, so quitting it forgets them. The DM check and a login waiting for its code live in the daemon's memory, so restarting the daemon forgets them.

An app created before suggested prompts existed lacks the agent view's thread events. `slack status` says so; run `bun src/cli.ts slack update jotaro` in a terminal to fix it. The command exports the app's manifest from Slack with a freshly rotated configuration token, checks that its bot is named after the dot and uses Socket Mode, lists the scopes and events it would add, and asks you to confirm. Only those are added; everything else in the manifest, including changes you made at api.slack.com, stays, since Slack's update replaces the whole manifest. The attempt is saved before the call. If Slack says the change needs your approval, `slack status` keeps telling you to reinstall the app until you run `slack update` again. If the answer is lost, nothing is sent again on its own: the next `slack update` checks the exported manifest to see whether it landed. **Update manifest…** in the app's Slack pane does the same, showing the changes and sending them only once you approve. The daemon never updates an app on its own.

What it does:

- While the dot works on your DM, the thread shows "jotaro is thinking…". The status is set once your message reaches the dot, kept up every minute, and cleared once the turn ends, also after a restart. Slack drops a status on its own after two minutes.
- The reply streams in as the dot writes it, in your DM and in a channel thread, where Slack streams it to you as its recipient. Once the turn ends, that same message is replaced with the turn's final answer, so text the dot wrote along the way, such as "Let me check", doesn't stay. The daemon follows OpenCode's live text events while any dot has its own app active, so the reply grows every 3 seconds with what the dot has written so far. Those events can't be replayed, so after the daemon or OpenCode reconnects, a paragraph that was already being written shows up only once it's finished. Reasoning and tool output are never shown. Where Slack won't stream, the reply is posted once at the end, as before.
- Opening an agent view thread or the app's Messages tab shows 2 to 4 suggested prompts: two everyday ones and the dot's purpose. Set your own with `bun src/cli.ts slack prompts jotaro prompts.json`, where the file holds 2 to 4 `{ "title": …, "message": … }` objects, each title one line of at most 75 characters and each message at most 1,000. `slack prompts jotaro` shows the current ones and `slack prompts jotaro --reset` goes back to the purpose's. Only your own openings get them; anyone else's are ignored.
- After the dot's first answer in an agent view thread, the thread is titled with the first 60 characters of your first message there, once. It's never renamed, so a title you give it later stays. Threads from before titles keep their old name.
- When you mention the dot in a channel, it replies once in that message's thread when its turn ends. Each mention gets its own reply, even if the dot answered several in one turn. The dot is given every message in the thread it hasn't seen yet, all of it the first time, as data framed in a `<slack-thread>` block; only your mention instructs it. If the thread can't be read in full, the mention waits and is tried again.
- A DM to the dot's app, including its agent view threads, goes to that dot, with no name needed. Top-level messages get replies under their own message; in-thread replies keep the root thread. The app shows your input with a short root quote when Slack can supply it.
- DM-origin workers and reminders return a saved notice to that original DM thread. Channel-origin delayed work goes to your DM with the original dot app, never an unsolicited channel post. Mention the dot again to ask for a channel update. Workers started outside Slack retain the existing behavior: a report goes to your dot-app DM only if the app is active when it finishes.
- When someone else mentions or DMs a dot, nothing reaches the dot. They get one note only they can see, such as "jotaro only answers @Afif.", once per conversation.
- The shared open-dot app can do the same for anyone who DMs it, but only once you turn it on with `bun src/cli.ts slack notices enable`. Until then it doesn't read its DMs for this or send any note. Once on, it checks once a minute and answers DMs sent from the moment you turned it on, including ones sent while the daemon was stopped, never older ones. Running `enable` again keeps that moment. `bun src/cli.ts slack notices disable` turns it off, and `bun src/cli.ts slack status` says which it is.

How it stays safe:

- An app is created only after you ask. The attempt is saved before the call. If Slack's answer is lost, the dot's app turns `unknown` and is never created again on its own: look for it at api.slack.com/apps and run `bun src/cli.ts slack attach jotaro <app ID>`, which has the daemon check that the app's bot is named after the dot and uses Socket Mode, or, if there's none, run `bun src/cli.ts slack connect jotaro --retry`. A late answer about an app you named earlier never changes one you've named since.
- A rotation is saved as started before the call. If its answer is lost or its new pair can't be saved, every later rotation stops, because Slack may already have used up the old refresh token. Generate a new pair and save it with `slack config`.
- A bot token is used only once `auth.test` shows a bot in your workspace and `bots.info` shows it belongs to the dot's app, and, once connected, the same bot and bot user as before, even for a token read again without a restart. A connection's `hello` never replaces the bot an app saved. Slack's `hello` must name the dot's app, and each event must name that app and workspace. A token saved in the wrong item is dropped and the Keychain read again a minute later.
- Each event is saved before Slack gets its acknowledgement, with only the fields open-dot needs and never the envelope's verification token. Slack sending it again, under the same or a new event ID, adds nothing. Only your own messages are kept with their words.
- A reply's ID is saved before it's posted, and the reply turns _unknown_ just before the post. An unknown reply is only looked up by that ID among the dot's own posts in that conversation, once a minute for an hour, and never posted again; if it's never found it stays unknown. Slack refusing a post marks it failed.
- A streamed reply is one message. Each stream step is saved before its call. A start whose answer is lost is only looked up, once a minute for an hour, by a marker block only that stream has, among the dot's own posts in the thread; it's never started again, and no other reply is posted for it. An append whose answer is lost is never sent again, and nothing more is appended; the final answer fills the message in instead. Stopping the stream and replacing its text are the only steps repeated after a lost answer, because repeating them changes nothing.
- A token check that fails, such as Slack answering `internal_error` to the bot token's `auth.test`, means the call it guarded was never sent, so a reply waiting on it is posted later rather than marked unknown or failed.
- If `slack config` can't turn off the terminal's echo, and show that it's off, it stops before asking for a token, and puts the terminal's settings back.
- A note to someone else is saved before it's sent and never sent twice, even if its answer was lost, so a note can go missing but never repeat.

The app's manifest asks for these bot scopes: `app_mentions:read`, `assistant:write`, `channels:history`, `chat:write`, `groups:history`, `im:history`, `im:read`, `im:write`, `metadata.message:read` and `users:read`, which `bots.info` needs. It subscribes to `app_mention`, `message.im`, `assistant_thread_started`, `assistant_thread_context_changed` and `app_home_opened` over Socket Mode. The thread's context Slack sends is never kept. Not yet checked live: whether Slack shows the AGENT badge, whether your workspace lets you install your own apps, whether Slack keeps a streamed message's marker block for the lookup, and whether `chat.update` with a markdown block replaces a streamed message as expected.

## Use the app

The open-dot app is a desktop app built with Electron. It talks only to the running daemon. Pick a dot, read and scroll back through its conversation, type to it with pasted or dropped images, reply, react, copy, share and delete messages, and open or stop its workers. The **Feed** lists what needs you, and each dot's ⋯ menu, or a right-click on the dot, opens its **Chat**, **Memory**, **Instructions**, **Library**, **Health** and **Slack**, and **Start Fresh…**.

Build and start it from the checkout:

```sh
bun run app:build     # build into app/build
bun run app:start     # build, then start it
bun run app:test      # its tests, against a fake daemon in a hidden window
bun run app:package   # build app/dist/mac-arm64/open-dot.app, signed ad hoc
```

It finds the daemon from `api.json`, so it follows `OPEN_DOT_HOME`. Closing the window hides it; Control-Option-Space or the menu bar icon shows it again. The menu bar icon shows when a dot is busy and how many messages you haven't read. If another app has Control-Option-Space, the icon's menu says so. Quit from that menu.

Command-1 shows the selected dot's chat, Command-2 its Memory and Command-3 its Instructions. Escape returns to the chat and keeps every draft, except while you're composing with an input method or a dialog is open. Clicking another dot keeps the pane you're in. Only the chat marks a dot's messages read; the feed and the other panes don't. Every control has a label for VoiceOver, menus work with the arrow keys, and dialogs put the safe choice first, with Escape to cancel.

A message you send gets its ID before it leaves the app, and the app saves only that ID until the daemon answers. It sends only to a daemon that said, since the app last found it, that it takes the app's IDs; one that saves a message under another ID gets no more sends until it's updated. If the answer is lost, the message stays in the box with a warning, and the app asks the daemon about that ID. Once the daemon says it has the message, what was sent leaves the box, keeping anything you typed since; if open-dot cancelled it, it stays in the box. It never sends the message again on its own.

Scroll up for older messages; the one you're reading stays put. When there's too little to scroll, older messages load on their own, and **Load older messages** fetches more. Past 600 loaded messages the newest ones make way and **Back to latest** returns to them; after the daemon restarts, older messages load again from the latest page. Delete hides a message after you confirm, with Undo for ten seconds; an Undo clicked before open-dot shows the delete saved waits for that, then restores the message. **Show deleted** lists hidden messages with **Restore**. Copy and Share read the message again from its conversation. Copy takes its text; only for an image-only message does it load every image again, and it copies nothing if any fails. Share loads every image again and shares nothing if any fails. If open-dot doesn't answer a reaction, delete or restore, the message keeps showing your change, marked **Not confirmed yet**, and takes no other change until open-dot shows it saved; **Try again** asks for the same change once more.

Paste an image or drop local image files onto the chat editor; there's no file picker. Each dot keeps its own draft with up to five PNG, JPEG, GIF or WebP images, at most 10 MiB each. Remove a thumbnail with ×. Return sends images with or without text. Screenshot TIFF paste converts locally to PNG; the app rejects images over 40 million pixels before decoding. Files must be regular local files, and their bytes determine the type. A failed or unconfirmed send keeps the draft and reply selection, with no automatic retry. Images added or text edited during a send remain in the draft. Pending messages keep small thumbnails; sent images load through conversation history. Drafts last for the app's lifetime; queued images persist in the daemon's outbox across restarts. The feed's Reply box takes pasted or dropped images the same way.

Click **Reply** on your own or a dot's real chat bubble to select it. Each dot keeps its own selected quote and draft; **Cancel** removes the selection. Sending stays in the same chat. The daemon reads the parent from that dot's public history and saves an immutable quote of up to 240 characters. The quote remains visible even when its parent leaves the recent message window. A failed send preserves the text and selection and is never retried automatically. A successful send clears only the draft and selection captured for that send, leaving edits made while it was saving intact. Pending replies also show their quote.

Right-click or Control-click a message, or click its ⋯ **Message actions** button, to open its menu. The top row holds the Tapbacks ❤️, 👍, 👎, 😂, ‼️ and ❓, the second the five emoji you chose most recently. Tapbacks are only for the dot's messages; choosing your selected one removes it, and choosing another replaces it. The dot can use `dot_react` to react to one of your messages with any single emoji. Reactions stay in open-dot: they don't mirror to Slack or start a turn, and the dot sees current feedback on its next model request. The rest of the menu has **Tapback Details…**, **Reply…**, **Copy**, **Share…** and **Delete…**, and says why an action is unavailable.

The **Feed** lists what needs you from GitHub, Linear and Slack. **Open** opens an item in the browser and **Dismiss** removes it, which also marks a GitHub or Linear item read there; **Clear all** dismisses everything shown. **Reply** sends an item to one or more dots: pick the dots, then write a prompt, or start from **Start on it** or **Use as context**, which only fill the box for you to edit. Each dot gets its own message with your prompt and the item, as data, once; a send that fails or gets no answer is shown under the item for that dot, with your prompt kept, and is never sent again on its own, while dots that got it aren't sent it again. The item moves to a collapsed **Handed off** list naming the dots it went to, where you can reply again to send it to more.

Each unfinished worker shows under the conversation. When one waits on a permission request or a question, its dot hears about it once, even if it goes away and comes back, and handles it first: the row says **dot handling**. The dot may approve a permission once or reject it (never always), or reply to or decline a question, with `dot_permission` and `dot_question`, and hands anything off limits or that only you can decide to you with `dot_escalate`. A worker may use its output directory, OpenCode's temporary directory, the repository it came from and any `paths` its dot passed to `dot_delegate` without asking. The dot's instructions keep it from approving deletes outside the worktree open-dot made for that worker (any delete, for a worker without one), force pushes, resets or other history rewrites, edits to `~/.config/opencode`, merges, deploys or marking pull requests ready on work repositories without your grant, requesting reviewers, publishing packages, and posts to Slack, Linear or Notion; open-dot also refuses to approve requests it recognizes as one of those, though that check is no sandbox. To let a dot approve its workers' merges, ready marks or deploys for a while, grant it at a terminal: `bun src/cli.ts grant add jojo merge --branch feat/foo --repo acme/app --until 18:00`, `grant add jojo ready --pr 34 --for 2h` or `grant add jojo deploy --target preview --until 18:00`. Each asks for your yes. A merge into main or master, or a production deploy, needs a grant that names it. `grant list` and `grant revoke <id>` manage them, and the dot's Memory pane in the app lists its active grants with **Revoke…**. A question that may ask for a secret goes straight to you, and open-dot keeps none of its words. A row says **needs you**, and the dot list counts it beside the dot, only once the dot or open-dot escalates it, an answer's outcome is unknown, or two minutes pass without an answer after the dot gets the notice, which reaches a busy dot at its next step (outside a Slack reply); each of those also puts one message in the dot's chat, never in Slack. An unknown answer stays marked, even after its worker finishes, in its own row beside the workers. The row shows a few words about the dot's latest answer, and the dot's Memory pane lists every request and answer, newest first with **Load older**, with when it was seen, answered, sent and confirmed; expand one to see OpenCode's request ID, the full request and the complete answer. They're kept after the worker finishes. The daemon alone sends an answer, once: it reads what the worker waits on, checks again that the worker is the dot's and running, that no supervision of its session is requested or active and that the request still waits, then saves the attempt before the call. A read that fails or takes over 10 seconds sends nothing and asks you instead, as does an answer still unsent a minute after the dot chose it. The grace period and these checks run on their own, so they reach you even while OpenCode can't be reached or another check is stuck. An answer whose outcome is lost stays unknown and is never sent again. The dot's own Threads workers get the same treatment, read from Threads' public snapshot; their row opens the session, and stopping them stays in Threads. **Open** opens the worker's session in a new terminal window, in the worker's directory, with `opencode2 -s <session>`. Set `OPEN_DOT_OPENCODE` for the daemon to use another binary, and `OPEN_DOT_TERMINAL` to `ghostty` or `terminal` to pick the app; without it the daemon uses Ghostty if it's installed, else Terminal. The first time, macOS may ask whether the daemon may control that app. If no window opens, the daemon copies the command to your clipboard and the app says so, showing the command. **Stop…** asks once, then interrupts the worker's run without resuming it. The worker stays stopped: nothing already queued for it is sent, its dot hears once that you stopped it, and it doesn't report back. If OpenCode doesn't confirm the stop, the worker shows **stopping, not confirmed** and still sends nothing; stop it again to retry. A message you type in its session later resumes it, as does a `dot_send` queued after the stop on a watch-and-send binding you still allow; nothing else does. You can still answer any permission or question yourself in its session.

Choose **Memory** to see what a dot remembers: its notes, its responsibilities, with any schedule, next run and past runs, and its scheduled reminders, each with when it last changed and who changed it. Add, edit and delete notes; edit a responsibility's goal and next action, or set it active, done or dropped, which pauses or resumes its schedule; change a reminder's time or repeat interval, or cancel it. A schedule itself can't be changed in the app; ask the dot. Deleting a note and cancelling a reminder ask first. Your edits don't start a turn: the dot sees them in its memory on its next message. An edit sends only the fields you changed and is saved only if the item hasn't changed since you started it; if the dot changed it meanwhile, nothing is saved and the app shows its current value beside your rejected text, which you can discard. A failed or unanswered change says so, keeps your edit open, and is never sent again on its own. Memory also lists what the observer noted (**Observed**), the sessions the dot supervises or asks to (**Approve…**, **Decline…**, **Revoke…**), its grants (**Revoke…**), its feed triggers (draft, preview, enable, pause and revoke) and every worker request and answer, newest first with **Load older**. The search box at the top finds notes, observations and archived messages, the same recall the dot has.

Nothing a dot or you save to its memory, purpose or instructions keeps a likely credential, such as a `ghp_`, `xoxb-` or `sk-` token or `password: …`: open-dot replaces it with `[redacted]`, best effort, and refuses a dot name, model, repository, grant scope or Library path that looks like one. To forget an observed row, choose **Forget…**; the observer won't note it again from the messages it came from or with the same text under any topic, but may if you say it again in a new message. To erase it completely, forget it and delete its source messages. **Forget and Delete Sources** also deletes the archived messages it came from, and an opened source has **Delete from Archive…**, so `dot_recall`, automatic recall and `dot_zoom` never find it again. `bun src/cli.ts archive delete jojo <message ID>` does the same at a terminal. OpenCode's own history keeps the messages. To let the observer note a forgotten fact again, type its text as it was into the Observed section's field and choose **Add**, or run `bun src/cli.ts observation add jojo "<text>"`; a fact put differently is added as yours and lifts no block.

A worker saves file deliverables, such as a report, in its own directory, `~/.opendot/outputs/<dot>/<worker>/`, which its task names. The dot adds one to its Library with `dot_library_add`, which keeps a private copy in `~/.opendot/library/<dot>/`: only that worker's own regular files, never links, other directories or URLs, and only `.txt`, `.md`, `.csv` or `.pdf` files of up to 10 MiB, with at most 200 files and 200 MiB per dot, counting copies on disk too. It needs macOS on Apple silicon, and those directories must stay yours and private (0700); open-dot refuses rather than repairs them. Choose **Library** from the dot's ⋯ menu in the app to list them, newest first, with their type, size and worker. **Export…** checks the bytes against the saved SHA-256 and saves a copy where you choose in the save dialog; it never opens or previews the file. A copy that's gone or changed says so and can't be exported.

Choose **Health** for the report `open-dot health` prints, with **Check again**.

To start the packaged app at login, hidden, save `~/Library/LaunchAgents/com.opzero1.open-dot.app.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.opzero1.open-dot.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/open-dot/app/dist/mac-arm64/open-dot.app/Contents/MacOS/open-dot</string>
    <string>--hidden</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
```

Start it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opzero1.open-dot.app.plist`. It restarts the app if it crashes, but not after you quit it. After `bun run app:package`, restart it with `launchctl kickstart -k gui/$(id -u)/com.opzero1.open-dot.app`.

The app replaced an earlier native notch app, which is gone from the repository. If its launch agent is still loaded, stop it with `launchctl bootout gui/$(id -u)/com.opzero1.open-dot.notch` and move `~/Library/LaunchAgents/com.opzero1.open-dot.notch.plist` out of the way.

open-dot keeps its data in `~/.opendot`. Set `OPEN_DOT_HOME` to use another directory.

## Check health

When a dot seems quiet, run:

```sh
open-dot doctor          # one line per check, with a next step
open-dot doctor --json   # the same report for scripts
```

It reports the daemon (through `api.json`), the database schema, OpenCode, each dot's saved
session, queued and unknown sends, each feed source's last pass, and Slack setup. Each check is
`healthy`, `stale`, `failed`, `unknown`, `not_configured` or `disabled`. It exits 1 when any check
failed. The app shows the same report under Health in a dot's ⋯ menu.

doctor only reads, and never opens the database file with SQLite. When no connection holds the
database (no `-wal`, `-shm` or `-journal` file beside it), it copies the file into memory and reads
the copy; a file that changes while it's copied is reported as unknown. While the daemon or
OpenCode's plugin holds the database, doctor doesn't read it. The running daemon instead reports
the snapshot it takes itself, at most every 15 seconds from a tick it already runs, never because
someone asked. The report's `sampledAt` says when its database checks were sampled, apart from
`checkedAt`. When the daemon has no snapshot yet, its last one is over a minute old, or its latest
attempt failed, `sampleUnavailable` says `missing`, `expired` or `failed` instead, and every
database check is unknown with no counts; a failure hides the older snapshot until a new one
succeeds. With the daemon stopped and the database held, the database checks read as unknown. No table is read unless the migration ledger matches
this version exactly. It never starts, stops or reloads the daemon or OpenCode: it finds OpenCode
with `Service.discover()` and makes only public reads, all within three seconds, after which no
read starts; it waits five seconds for the daemon's report, whose own OpenCode reads end within
three. It reads no Keychain item and sends no message.
Its words are fixed text with counts: no names, tokens, paths, session or Slack IDs, message text
or raw errors, and none of the daemon's own words. `open-dot slack status` still gives Slack's full
explanation; a Slack app saved as active is reported as unknown, since a saved state isn't a
working connection.

Feed passes are known only to a running daemon, in memory, so they read as unknown while it's
stopped and until its first pass after a start. A send whose outcome was lost stays unknown until
open-dot looks it up by ID; doctor sends nothing.

## Back up and restore

Before applying pending migrations, every database opener (plugin, daemon or CLI) makes a
`VACUUM INTO` snapshot in `~/.opendot/backups/`, checks the copy with `PRAGMA integrity_check`,
then migrates. A failed backup or integrity check blocks migration and names the backup path.
Files are named `open-dot-<UTC timestamp>-before-<first pending migration>.db`. Ordinary opens
with no pending migrations do not back up or acquire the migration lock. Concurrent migrators
wait for the same SQLite lock, then recheck the ledger; the lock is released even if a process
crashes. Waiting is bounded to 60 seconds; a timeout fails the open instead of migrating unlocked.
In-memory test databases have no backups. `open-dot` with no command, `help` or an unknown command
prints its usage without opening the database.

Make a backup without running migrations:

```sh
open-dot backup
# Or from the checkout: bun src/cli.ts backup
```

The command prints the verified backup's path. Backups are private files (0600); the ten newest
generated backups are kept, across automatic, manual and pre-restore copies. Copy a backup
elsewhere if you want to keep it indefinitely. `OPEN_DOT_HOME` also relocates the backups.

Restore only during a quiet period: stop the daemon and pause other open-dot activity, including
tools in existing OpenCode dot sessions. Do not reload OpenCode to do this. Restore changes only
open-dot's database, not OpenCode history, Keychain items or worktrees. It refuses while a daemon
holds the database's daemon lock, including during startup. On macOS, unload the launch agent
rather than just killing its process, since KeepAlive would restart it:

```sh
launchctl bootout gui/$(id -u)/com.opzero1.open-dot.daemon
open-dot restore /path/to/backup.db
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opzero1.open-dot.daemon.plist
```

For a foreground daemon, stop it with Control-C instead. Restore requires `sqlite3` on `PATH`
(included with macOS). It checks the source, stages a verified SQLite snapshot, backs up the
current database, then uses SQLite's backup API to restore **in place**. It never renames the
database or removes its WAL under existing plugin connections. Busy SQLite transactions may
block restore; a failure is reported, never retried automatically. A successful restore prints
the pre-restore backup path. It does not migrate the restored file: the next normal open backs
up and applies any pending migrations. The `.migration-lock` and `.daemon-lock` files beside
the database are persistent SQLite lock files, not PID files; do not delete them.
