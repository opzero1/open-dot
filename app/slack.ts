// A dot's Slack app as the app shows it, in the words `open-dot slack status` uses, and the token
// forms clipboard pickup accepts. Plain functions, shared by main and the renderer, never a token.
import type { PickupStep, SlackSetup } from "./bridge";

export type { PickupStep };

export const pickupNames: Record<PickupStep, string> = {
  access: "configuration access token",
  refresh: "configuration refresh token",
  bot: "bot token",
  app: "app-level token",
  linkBot: "bot token",
  linkApp: "app-level token",
};

/** The step whose token is held in main's memory until this one's arrives. */
export const pickupAfter = (step: PickupStep): PickupStep | undefined =>
  step === "refresh" ? "access" : step === "linkApp" ? "linkBot" : undefined;

/** How long a pickup watches, and how long a held first token waits for its pair. */
export const pickupMilliseconds = 120_000;

const appIDPattern = /^A[A-Z0-9]{6,31}$/;

export const isSlackAppID = (value: unknown): value is string =>
  typeof value === "string" && appIDPattern.test(value);

/**
 * Whether `text` is exactly one token of the step's form, anchored at both ends. An app-level
 * token names its app, so it must name this one.
 */
export const tokenMatches = (step: PickupStep, text: string, appID: string | undefined) => {
  if (new TextEncoder().encode(text).length > 1024) return false;
  switch (step) {
    case "access":
      return /^xoxe\.xoxp-[0-9]{1,4}-[A-Za-z0-9]{20,1000}$/.test(text);
    case "refresh":
      return /^xoxe-[0-9]{1,4}-[A-Za-z0-9]{20,1000}$/.test(text);
    case "bot":
    case "linkBot":
      return /^xoxb-[0-9]{1,20}-[0-9]{1,20}-[A-Za-z0-9]{20,64}$/.test(text);
    case "app":
      return (
        isSlackAppID(appID) &&
        new RegExp(`^xapp-[0-9]{1,4}-${appID}-[0-9]{1,20}-[A-Za-z0-9]{20,128}$`).test(text)
      );
    case "linkApp":
      return /^xapp-[0-9]{1,4}-A[A-Z0-9]{6,31}-[0-9]{1,20}-[A-Za-z0-9]{20,128}$/.test(text);
    default:
      return false;
  }
};

/** The app an app-level token names, as `xapp-<n>-<app ID>-…`. */
export const linkAppID = (token: string) => /^xapp-[0-9]{1,4}-(A[A-Z0-9]{6,31})-/.exec(token)?.[1];

/** Slack's own pages for an app, only for an ID of Slack's form. */
export const slackLinks = (appID: string | null | undefined) => {
  if (!isSlackAppID(appID)) return undefined;
  const base = `https://api.slack.com/apps/${appID}`;
  return { install: `${base}/install-on-team`, general: `${base}/general`, oauth: `${base}/oauth` };
};

/** Only Slack's app pages open from this view. */
export const isSlackAppPage = (raw: string) => {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.host === "api.slack.com" &&
      !url.username &&
      !url.password &&
      (url.pathname === "/apps" || url.pathname.startsWith("/apps/"))
    );
  } catch {
    return false;
  }
};

export const canAttach = (state: string | undefined) =>
  state === undefined || ["requested", "failed", "unknown", "attaching"].includes(state);

export const canUpdate = (app: NonNullable<SlackSetup["app"]>) =>
  app.manifestOutdated || app.updateState !== null || app.updateNote !== null;

export const needsLogin = (setup: SlackSetup) => !!setup.login && setup.login.state !== "ready";

export const needsConfig = (setup: SlackSetup) =>
  setup.config.saved !== true || setup.config.state === "blocked";

export const canRetryInstall = (setup: SlackSetup) => {
  const app = setup.app;
  if (!app || app.state !== "created" || setup.login?.state !== "ready") return false;
  return app.install?.phase !== "queued" && app.install?.phase !== "sending";
};

export const loginLine = (login: NonNullable<SlackSetup["login"]>) => {
  switch (login.state) {
    case "ready":
      return `Logged in to Slack${login.team ? ` in ${login.team}` : ""}. Install creates and installs each dot's app with it.`;
    case "relogin":
      return `Log in to Slack again: ${login.problem ?? "the saved login can't be used."}`;
    case "none":
      return "Not logged in to Slack. Log in once for this workspace, and Install does the rest.";
    default:
      return "Log in to Slack once for this workspace, and Install creates and installs each dot's app. If you logged in before, the daemon finds it when it next needs it.";
  }
};

export const installLine = (install: NonNullable<SlackSetup["app"]>["install"]) => {
  if (!install) return undefined;
  switch (install.phase) {
    case "queued":
    case "sending":
      return "The daemon is installing the app with your Slack login.";
    case "saved":
      return "Installed with your Slack login, and both tokens are in the Keychain. Saved isn't connected: this says Connected once the daemon has checked them.";
    case "approval":
      return install.code === "app_approval_request_eligible"
        ? "Waiting for admin approval. open-dot hasn't asked for it: request approval on the app's install page, then Retry install once an admin approves."
        : install.code === "app_approval_request_pending"
          ? "Waiting for admin approval: the request is with your workspace's admins. Retry install once one approves."
          : "An admin denied this app. Ask your admins, then Retry install.";
    default:
      return `Installing didn't finish (${install.code ?? "slack_error"}). Retry install, or install the same app yourself below.`;
  }
};

export const linkWarning = (app: SlackSetup["app"], dot: string) => {
  const base = "The prefilled link makes a new app in Slack each time you use it.";
  if (!app) return base;
  if (app.appID && (app.state === "created" || app.state === "active"))
    return `${base} ${dot} already has the app ${app.appID}: another would be a duplicate, and binding it replaces ${app.appID} only once you confirm. ${app.appID} stays in Slack until you delete it.`;
  if (app.state === "unknown")
    return `${base} Creating ${dot}'s app got no clear answer, so one may already exist at api.slack.com/apps; look there first.`;
  return base;
};

export const slackTitle = (app: SlackSetup["app"]) =>
  app ? `App ${app.appID ?? ""} · ${app.state}` : "No app";

export const slackSummary = (setup: SlackSetup, dot: string) => {
  const app = setup.app;
  if (!app)
    return `${dot} has no Slack app of its own. Install asks the daemon to create one named ${dot} and install it with your Slack login. Without a login, use the prefilled link below.`;
  switch (app.state) {
    case "requested":
      return "Requested. The daemon creates the app with your Slack login, or your configuration token, within about 10 seconds.";
    case "creating":
      return "The daemon is creating the app now.";
    case "unknown":
      return `Creating the app got no clear answer, so it may exist. Look for an app named ${dot} at api.slack.com/apps and attach its ID, or create it again with Retry.`;
    case "attaching":
      return "The daemon is checking that app with Slack.";
    case "failed":
      return "Slack refused to create the app. Try again with Install.";
    case "created": {
      const line = installLine(app.install);
      return line
        ? `Created. ${line}`
        : "Created. Install it in Slack (Install, then Allow), then save its bot token and an app-level token with the connections:write scope, by pickup or in the fields. Saved isn't connected: the daemon checks them within a minute and connects.";
    }
    case "active":
      return `Connected${app.botUser ? ` as <@${app.botUser}>` : ""}. Invite it to a channel with /invite @${dot}, then mention it there, or DM it.`;
    default:
      return `State: ${app.state}.`;
  }
};

export const iconLine = (
  icon: NonNullable<NonNullable<SlackSetup["app"]>["icon"]>,
  dot: string,
) => {
  const manual =
    "Set it yourself: open App settings, scroll to Display Information, upload the avatar under App icon & Preview, then click Save Changes. Or Retry icon.";
  switch (icon.status) {
    case "no-avatar":
      return `${dot} has no avatar yet. Set one with open-dot avatar ${dot} <file>, and the daemon sets it as the app's icon.`;
    case "set":
      return "Icon set from the avatar.";
    case "setting":
      return "The daemon is setting the icon from the avatar now.";
    case "waiting":
      return "Slack is rate limiting icon changes. The daemon tries again on its own once Slack allows.";
    case "refused":
      return icon.error === "unknown_outcome"
        ? `Setting the icon got no clear answer (unknown_outcome), so it may have worked, and it's never sent again on its own. Check the icon in Slack. If it isn't the avatar, set it yourself: open App settings, scroll to Display Information, upload the avatar under App icon & Preview, then click Save Changes. Or Retry icon.`
        : `Slack refused to set the icon (${icon.error ?? "slack_error"}). ${manual}`;
    default:
      return "The daemon sets the icon from the avatar within a minute or two.";
  }
};

const shortTime = (milliseconds: number) =>
  new Date(milliseconds).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const ownerFeedLine = (feed: SlackSetup["ownerFeed"]) => {
  const what =
    "Your own Slack feed (the shared open-dot app, with your user token) is separate from this bot.";
  if (!feed) return `${what} This daemon doesn't report it.`;
  if (feed.items <= 0 || feed.latestAt === null)
    return `${what} open-dot has saved no Slack items from it. This view doesn't check its token; Health shows its last pass.`;
  return `${what} open-dot has saved ${feed.items} Slack items from it, the newest from ${shortTime(feed.latestAt)}. This view doesn't check its token; Health shows its last pass.`;
};

export const dmCheckLine = (check: SlackSetup["dmCheck"], dot: string) => {
  if (!check)
    return `DM check: not started. Start it, then send ${dot} a DM in Slack yourself. Nothing is sent for you.`;
  if (check.state === "replied" && check.dmAt !== null)
    return `DM check: ${dot} replied in Slack to your DM from ${shortTime(check.dmAt)}, as open-dot's saved record of its posted reply shows.`;
  return `DM check: pending since ${shortTime(check.since)}. Send ${dot} a DM in Slack yourself; this changes only once Slack confirmed its reply. A queued reply doesn't count, and restarting the daemon forgets the check.`;
};

export const pickupDisclosure =
  "Pickup is off until you press Pick up. It then watches the clipboard for 2 minutes for that one token, takes only a copy made after you pressed it that is exactly that token, clears that copy, and stops when you leave this view. A clipboard manager or Universal Clipboard may keep its own copy. You can type or paste into the secure fields instead.";
