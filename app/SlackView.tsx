/** @jsxImportSource react */
// A dot's own Slack app: login, install, its tokens and the conversation check. Tokens typed here
// live only in their password fields until sent once to the daemon, then the field is cleared;
// picked-up tokens stay in main and never reach this page.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PickupState, PickupStep, Reply, SlackSetup, SlackTicket } from "./bridge";
import {
  canAttach,
  canRetryInstall,
  canUpdate,
  dmCheckLine,
  iconLine,
  isSlackAppPage,
  linkAppID,
  linkWarning,
  loginLine,
  needsLogin,
  needsConfig,
  ownerFeedLine,
  pickupDisclosure,
  pickupNames,
  slackLinks,
  slackSummary,
  slackTitle,
} from "./slack";
import { type AskOwner, bridge } from "./ui";

type Field = "access" | "refresh" | "bot" | "app" | "linkBot" | "linkApp" | "challenge";

/** How long typed tokens wait for the owner to confirm they replace the dot's app. */
const replaceMilliseconds = 120_000;

const open = (url: string | undefined) => {
  if (url && isSlackAppPage(url)) void bridge.openLink(url);
};

const isSetup = (value: unknown): value is SlackSetup =>
  typeof value === "object" && value !== null && "config" in value && "app" in value;

export const Slack = ({ dot, ask }: { dot: string; ask: AskOwner }) => {
  const [setup, setSetup] = useState<SlackSetup>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<SlackTicket>();
  const [pickup, setPickup] = useState<PickupState>();
  // Which apps the owner marked as waiting for admin approval, and which tokens were saved.
  const [approval, setApproval] = useState(new Set<string>());
  const [saved, setSaved] = useState(new Map<string, Set<string>>());
  const [appID, setAppID] = useState("");
  // The secret fields' values stay in the DOM; only whether each has text is state.
  const fields = useRef(new Map<Field, HTMLInputElement>());
  const [filled, setFilled] = useState(new Set<Field>());
  // Whether this view is still open, and the setup it shows, for a dialog answered later.
  const shown = useRef(true);
  const setupRef = useRef<SlackSetup>(undefined);
  setupRef.current = setup;
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const result = await bridge.call("slack", dot);
    if (!result.ok) return setError(result.error);
    setError(undefined);
    setSetup(result.value);
  }, [dot]);

  useEffect(() => {
    setSetup(undefined);
    setTicket(undefined);
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const bound = setup?.app?.appID ?? null;
  // Main watches the clipboard only while this dot's view is open, for its app as shown.
  useEffect(() => {
    void bridge.slackShown(dot, bound);
  }, [dot, bound]);
  useEffect(() => () => void bridge.slackShown(null, null), []);

  useEffect(
    () =>
      bridge.onEvent((event) => {
        if (event.kind !== "pickup") return;
        setPickup(event.state);
        if (event.state.dot === dot && event.state.notice) void refresh();
      }),
    [dot, refresh],
  );

  // A picked-up link that would replace the dot's app waits in main for the owner.
  const replacing = pickup?.dot === dot ? pickup.replace : null;
  useEffect(() => {
    if (!replacing) return;
    ask({
      title: `Replace ${dot}'s Slack app?`,
      text: `${dot} is bound to the app ${replacing}. These tokens belong to another app, which would take its place, and open-dot would forget ${replacing}'s bot. ${replacing} stays in Slack until you delete it there.`,
      buttons: [
        {
          label: "Cancel",
          run: () => void bridge.confirmReplace(dot, replacing, false).then(setPickup),
        },
        {
          label: "Replace it",
          danger: true,
          run: () => void bridge.confirmReplace(dot, replacing, true).then(setPickup),
        },
      ],
    });
  }, [replacing]);

  const answer = (result: Reply<unknown>, done?: string) => {
    if (result.ok) {
      setError(undefined);
      if (isSetup(result.value)) setSetup(result.value);
      if (done) setNotice(done);
      return true;
    }
    setError(
      result.lost
        ? "Couldn't confirm the daemon got this. It isn't sent again: check this view after it refreshes."
        : result.error,
    );
    return false;
  };

  const run = async (work: () => Promise<Reply<unknown>>, done?: string) => {
    if (busy) return false;
    setBusy(true);
    setNotice(undefined);
    try {
      const ok = answer(await work(), done);
      if (ok) void refresh();
      return ok;
    } finally {
      setBusy(false);
    }
  };

  /** Takes a field's value once and clears it at once. */
  const take = (field: Field) => {
    const input = fields.current.get(field);
    const value = input?.value.trim() ?? "";
    if (input) input.value = "";
    setFilled((current) => {
      const next = new Set(current);
      next.delete(field);
      return next;
    });
    return value;
  };

  /** Clears both typed tokens of a link. */
  const dropLink = () => {
    take("linkBot");
    take("linkApp");
  };

  const secretField = (field: Field, label: string) => (
    <input
      type="password"
      className="secret"
      aria-label={label}
      placeholder={label}
      autoComplete="off"
      spellCheck={false}
      ref={(input) => {
        if (input) fields.current.set(field, input);
        else fields.current.delete(field);
      }}
      onInput={(event) => {
        const has = event.currentTarget.value.length > 0;
        setFilled((current) => {
          if (current.has(field) === has) return current;
          const next = new Set(current);
          if (has) next.add(field);
          else next.delete(field);
          return next;
        });
      }}
      data-secret={field}
    />
  );

  const pickupButton = (step: PickupStep, disabled = false) => {
    const armed = pickup?.dot === dot && pickup.step === step;
    return (
      <button
        type="button"
        disabled={(disabled && !armed) || pickup?.available === false}
        data-pickup={step}
        onClick={() =>
          void bridge
            .pickup(dot, armed ? null : step, step === "bot" || step === "app" ? bound : null)
            .then(setPickup)
        }
      >
        {armed ? "Stop pickup" : `Pick up ${pickupNames[step]}`}
      </button>
    );
  };

  const pickupStatus = (steps: PickupStep[]) =>
    pickup?.dot === dot && pickup.step && steps.includes(pickup.step) ? (
      <p className="warn" data-pickup-status>
        Waiting up to 2 minutes for you to Copy the {pickupNames[pickup.step]} in Slack.
        {pickup.mismatched ? " The last copy wasn't one, so it was ignored and not kept." : ""}
      </p>
    ) : null;

  const saveToken = (kind: "bot" | "app") => {
    const value = take(kind);
    if (!value || !bound) return;
    const app = bound;
    void run(() => bridge.secret({ kind: "slackToken", dot, token: kind, value })).then((ok) => {
      if (ok)
        setSaved((current) =>
          new Map(current).set(app, new Set([...(current.get(app) ?? []), kind])),
        );
    });
  };

  const connectLink = () => {
    // Only the app ID is read here. If the tokens would replace the dot's app, they stay in their
    // fields while the owner decides, and the dialog's buttons hold IDs alone.
    const named = linkAppID(fields.current.get("linkApp")?.value.trim() ?? "");
    const current = setup?.app;
    const other =
      current?.appID &&
      (current.state === "created" || current.state === "active") &&
      named !== current.appID
        ? current.appID
        : undefined;
    const send = (replaceAppID?: string) => {
      const bot = take("linkBot");
      const app = take("linkApp");
      if (!bot || !app) return;
      void run(
        () =>
          bridge.secret({
            kind: "slackLink",
            dot,
            bot,
            app,
            ...(replaceAppID ? { replaceAppID } : {}),
          }),
        "Both tokens sent to the daemon once. Saved isn't connected: this view says Connected only once the daemon checked them.",
      );
    };
    if (!other) return send();
    const asked = Date.now();
    ask({
      title: `Replace ${dot}'s Slack app?`,
      text: `${dot} is bound to the app ${other}. These tokens belong to another app, which would take its place, and open-dot would forget ${other}'s bot. ${other} stays in Slack until you delete it there.`,
      buttons: [
        { label: "Cancel", run: dropLink },
        {
          label: "Replace it",
          danger: true,
          run: () => {
            // Sent only from this view as it still is: the same app bound, the same app's token
            // in the field, and within the 2 minutes a held token is kept. Otherwise both go.
            const now = fields.current.get("linkApp")?.value.trim() ?? "";
            if (
              !shown.current ||
              Date.now() - asked > replaceMilliseconds ||
              setupRef.current?.app?.appID !== other ||
              linkAppID(now) !== named
            ) {
              dropLink();
              setError(
                "Nothing was sent: this view changed or 2 minutes passed. Enter both tokens again.",
              );
              return;
            }
            send(other);
          },
        },
      ],
    });
  };

  const update = async () => {
    if (busy) return;
    setBusy(true);
    const result = await bridge.call("slackUpdate", dot, null);
    setBusy(false);
    if (!result.ok) {
      answer(result);
      return;
    }
    setNotice(result.value.said);
    const changes = result.value.confirm;
    if (!changes?.length) {
      void refresh();
      return;
    }
    ask({
      title: `Update ${dot}'s Slack app?`,
      text: `This adds to its manifest, keeping everything else in it:\n\n${changes.join("\n")}`,
      buttons: [
        { label: "Cancel" },
        {
          label: "Update",
          run: () =>
            void run(async () => {
              const approved = await bridge.call("slackUpdate", dot, changes);
              if (approved.ok) setNotice(approved.value.said);
              return approved;
            }),
        },
      ],
    });
  };

  const loginSection = (login: NonNullable<SlackSetup["login"]>) => {
    const live = ticket && ticket.expiresAt > Date.now() ? ticket : undefined;
    return (
      <section className="pane-section" aria-label="Slack login">
        <h3>Slack login</h3>
        <p data-slack-login-line>{loginLine(login)}</p>
        {live ? (
          <>
            <p>1. Run this in any Slack channel or DM, then approve it:</p>
            <pre className="mono" data-slack-command>
              {live.command}
            </pre>
            <button type="button" onClick={() => void bridge.copyText(live.command)}>
              Copy command
            </button>
            <p>2. Enter the code Slack shows. It's sent once; a wrong one needs a new login.</p>
            <div className="field-row">
              {secretField("challenge", "Challenge code")}
              <button
                type="button"
                disabled={busy || !filled.has("challenge")}
                onClick={() => {
                  const challenge = take("challenge");
                  if (!challenge) return;
                  setTicket(undefined);
                  void run(() =>
                    bridge.secret({
                      kind: "slackChallenge",
                      dot,
                      attempt: live.attempt,
                      challenge,
                    }),
                  );
                }}
              >
                Finish login
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await bridge.call("slackLogin");
                if (result.ok) setTicket(result.value);
                return result;
              })
            }
          >
            {login.state === "ready" ? "Log in again" : "Log in to Slack"}
          </button>
        )}
      </section>
    );
  };

  const holding = (step: "access" | "linkBot") => pickup?.dot === dot && pickup.holding === step;

  const configSection = (current: SlackSetup) => {
    const first = needsConfig(current);
    return (
      <div className="config" aria-label="Configuration tokens">
        <h4>
          {first
            ? "Configuration tokens, not saved yet"
            : "Configuration tokens, saved for this workspace"}
        </h4>
        <p className="note">
          {first
            ? "Optional with the Slack login. Manifest updates and setting the app's icon use them, and Install falls back to them without a login: open Your App Configuration Tokens, Generate Token for the workspace, then pick up the access token and then the refresh token. The daemon rotates the saved pair before each use."
            : "open-dot saved a pair before and rotates it before each use. Replace the pair only if it's blocked."}
        </p>
        {current.config.state === "blocked" ? (
          <p className="warn">
            {current.config.problem ?? "Rotation is blocked. Save a new pair."}
          </p>
        ) : null}
        <div className="item-actions">
          <button type="button" onClick={() => open("https://api.slack.com/apps")}>
            Open configuration tokens
          </button>
          {pickupButton("access")}
          {pickupButton("refresh", !holding("access"))}
        </div>
        {holding("access") ? (
          <p className="warn">
            Access token held in memory only, until the refresh token is picked up.
          </p>
        ) : null}
        {pickupStatus(["access", "refresh"])}
        {secretField("access", "Access token (xoxe.xoxp-…)")}
        {secretField("refresh", "Refresh token (xoxe-…)")}
        <button
          type="button"
          disabled={busy || !filled.has("access") || !filled.has("refresh")}
          onClick={() => {
            const token = take("access");
            const refreshToken = take("refresh");
            if (token && refreshToken)
              void run(
                () => bridge.secret({ kind: "slackConfig", token, refreshToken }),
                "Configuration tokens sent to the daemon once.",
              );
          }}
        >
          Save configuration tokens
        </button>
      </div>
    );
  };

  const app = setup?.app ?? null;
  const links = slackLinks(app?.appID);
  const savedHere = saved.get(app?.appID ?? "") ?? new Set<string>();
  const pickupNotice = pickup?.dot === dot ? pickup.notice : null;

  return (
    <div className="pane slack" aria-label={`${dot}'s Slack`} data-pane="slack">
      <header className="pane-head">
        <h2>Slack</h2>
      </header>
      <div className="pane-body">
        {error ? (
          <div className="item-error" role="alert" data-slack-error>
            {error}
          </div>
        ) : null}
        {notice || pickupNotice ? (
          <div className="notice" role="status" data-slack-notice>
            {pickupNotice ?? notice}
          </div>
        ) : null}
        {!setup ? (
          error ? null : (
            <p className="empty-line">Loading…</p>
          )
        ) : (
          <>
            {needsLogin(setup) && setup.login ? loginSection(setup.login) : null}
            <section className="pane-section" aria-label="App" data-slack-state>
              <h3>{slackTitle(app)}</h3>
              <p>{slackSummary(setup, dot)}</p>
              {app?.problem ? <p className="warn">Problem: {app.problem}</p> : null}
              {app?.updateNote ? <p>Manifest update: {app.updateNote}</p> : null}
              <div className="item-actions">
                {!app || app.state === "failed" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => bridge.call("slackConnect", dot, false))}
                  >
                    Install
                  </button>
                ) : null}
                {app?.state === "unknown" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      ask({
                        title: `Create ${dot}'s Slack app again?`,
                        text: `Creating it got no clear answer, so it may exist. Only continue if you checked api.slack.com/apps and there's no app named ${dot}. If there is one, attach its ID instead.`,
                        buttons: [
                          { label: "Cancel" },
                          {
                            label: "There's no app, create it",
                            run: () => void run(() => bridge.call("slackConnect", dot, true)),
                          },
                        ],
                      })
                    }
                  >
                    Retry create…
                  </button>
                ) : null}
                {canRetryInstall(setup) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => bridge.call("slackInstall", dot))}
                  >
                    {app?.install ? "Retry install" : "Install with Slack login"}
                  </button>
                ) : null}
              </div>
              {canAttach(app?.state) ? (
                <div className="field-row">
                  <input
                    aria-label="App ID"
                    placeholder="App ID (A…)"
                    value={appID}
                    onChange={(event) => setAppID(event.target.value)}
                  />
                  <button
                    type="button"
                    disabled={busy || !appID.trim()}
                    onClick={() => {
                      const id = appID.trim();
                      setAppID("");
                      void run(() => bridge.call("slackAttach", dot, id));
                    }}
                  >
                    Attach
                  </button>
                </div>
              ) : null}
              {app && links && (app.state === "created" || app.state === "active") ? (
                <>
                  {app.state === "active" || app.install?.phase !== "saved" ? (
                    <div className="steps">
                      <p>
                        1. Install it in Slack: review what it asks for, then Allow. If Slack says
                        an admin must approve it, request approval and mark it here.
                      </p>
                      {approval.has(app.appID ?? "") ? (
                        <>
                          <p className="warn">
                            Waiting for admin approval, as you marked it. open-dot doesn't see
                            approvals, so nothing here changes on its own. Once an admin approves,
                            resume.
                          </p>
                          <div className="item-actions">
                            <button type="button" onClick={() => open(links.install)}>
                              Resume installation
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setApproval((current) => {
                                  const next = new Set(current);
                                  next.delete(app.appID ?? "");
                                  return next;
                                })
                              }
                            >
                              Clear mark
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="item-actions">
                          <button type="button" onClick={() => open(links.install)}>
                            Install in Slack
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setApproval((current) => new Set(current).add(app.appID ?? ""))
                            }
                          >
                            Waiting for admin approval
                          </button>
                        </div>
                      )}
                      <p>
                        2. On OAuth & Permissions, Copy the Bot User OAuth Token.
                        {savedHere.has("bot") ? " Saved." : ""}
                      </p>
                      <div className="item-actions">
                        <button type="button" onClick={() => open(links.oauth)}>
                          Open OAuth page
                        </button>
                        {pickupButton("bot")}
                      </div>
                      <div className="field-row">
                        {secretField("bot", "Bot token (xoxb-…)")}
                        <button
                          type="button"
                          disabled={busy || !filled.has("bot")}
                          onClick={() => saveToken("bot")}
                        >
                          Save
                        </button>
                      </div>
                      <p>
                        3. On Basic Information under App-Level Tokens, Generate Token and Scopes,
                        add connections:write, Generate, then Copy.
                        {savedHere.has("app") ? " Saved." : ""}
                      </p>
                      <div className="item-actions">
                        <button type="button" onClick={() => open(links.general)}>
                          Open App-Level Tokens
                        </button>
                        {pickupButton("app")}
                      </div>
                      <div className="field-row">
                        {secretField("app", "App-level token (xapp-…)")}
                        <button
                          type="button"
                          disabled={busy || !filled.has("app")}
                          onClick={() => saveToken("app")}
                        >
                          Save
                        </button>
                      </div>
                      {pickupStatus(["bot", "app"])}
                      {app.state === "created" && savedHere.has("bot") && savedHere.has("app") ? (
                        <p>
                          Both tokens are saved in the Keychain. Saved isn't connected: the daemon
                          checks them within a minute, and this says Connected only once it has.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {canUpdate(app) ? (
                    <button type="button" disabled={busy} onClick={() => void update()}>
                      Update manifest…
                    </button>
                  ) : null}
                  {app.icon ? (
                    <>
                      <p data-slack-icon>{iconLine(app.icon, dot)}</p>
                      <div className="item-actions">
                        {app.icon.status === "refused" ? (
                          <button type="button" onClick={() => open(links.general)}>
                            Open App settings
                          </button>
                        ) : null}
                        {app.icon.status === "no-avatar" ? null : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void run(() => bridge.call("slackIcon", dot))}
                          >
                            Retry icon
                          </button>
                        )}
                      </div>
                    </>
                  ) : null}
                </>
              ) : null}
            </section>
            {app?.state === "active" ? (
              <section className="pane-section" aria-label={`Talking to ${dot} in Slack`}>
                <h3>Talking to {dot} in Slack</h3>
                <p>
                  Bot: {app.botUser ? `<@${app.botUser}>` : "not known yet"} in {dot}'s own app{" "}
                  {app.appID ?? ""}. It speaks only as {dot}.
                </p>
                <p>{ownerFeedLine(setup.ownerFeed)}</p>
                <p>
                  DM {dot} from its Messages tab or agent view in Slack. In a channel, /invite @
                  {dot}, then mention it; for a private channel, invite it from inside that channel.
                  It sees only conversations it's in, and answers only you.
                </p>
                <p data-slack-dm-check>{dmCheckLine(setup.dmCheck, dot)}</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => bridge.call("slackDMCheck", dot))}
                >
                  {setup.dmCheck ? "Restart DM check" : "Start DM check"}
                </button>
              </section>
            ) : (
              <section className="pane-section" aria-label="Or create it yourself">
                <h3>Or create it yourself</h3>
                <p className="warn">{linkWarning(app, dot)}</p>
                <p>
                  Open the prefilled link, pick the workspace and Create. Install it to the
                  workspace, then copy the Bot User OAuth Token from OAuth & Permissions, and under
                  Basic Information generate an app-level token with connections:write.
                </p>
                <div className="item-actions">
                  {setup.manifestLink && isSlackAppPage(setup.manifestLink) ? (
                    <button type="button" onClick={() => open(setup.manifestLink ?? undefined)}>
                      Open prefilled link
                    </button>
                  ) : null}
                  {pickupButton("linkBot")}
                  {pickupButton("linkApp", !holding("linkBot"))}
                </div>
                {holding("linkBot") ? (
                  <p className="warn">
                    Bot token held in memory only, until the app-level token is picked up.
                  </p>
                ) : null}
                {pickupStatus(["linkBot", "linkApp"])}
                {secretField("linkBot", "Bot token (xoxb-…)")}
                {secretField("linkApp", "App-level token (xapp-…)")}
                <button
                  type="button"
                  disabled={busy || !filled.has("linkBot") || !filled.has("linkApp")}
                  onClick={connectLink}
                >
                  Connect this app
                </button>
              </section>
            )}
            {setup.login && !needsLogin(setup) ? loginSection(setup.login) : null}
            {setup.login ? (
              <details className="pane-section">
                <summary>Advanced: configuration tokens</summary>
                {configSection(setup)}
              </details>
            ) : (
              <section className="pane-section">{configSection(setup)}</section>
            )}
            <p className="note" data-pickup-disclosure>
              {pickupDisclosure}
            </p>
          </>
        )}
      </div>
    </div>
  );
};
