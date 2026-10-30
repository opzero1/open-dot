// The sandboxed preload: exposes exactly the bridge's operations, never ipcRenderer itself.
import { contextBridge, ipcRenderer } from "electron";
import { type AppEvent, type Bridge, type Channel, eventChannel } from "./bridge";

const call =
  (channel: Channel) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

const bridge: Bridge = {
  dots: call("dots"),
  messages: call("messages"),
  message: call("message"),
  send: call("send"),
  attempts: call("attempts"),
  reconcile: call("reconcile"),
  forget: call("forget"),
  react: call("react"),
  hide: call("hide"),
  pending: call("pending"),
  image: call("image"),
  avatar: call("avatar"),
  ingest: call("ingest"),
  openLink: call("openLink"),
  copyText: call("copyText"),
  shareText: call("shareText"),
  copyMessage: call("copyMessage"),
  shareMessage: call("shareMessage"),
  emojiPanel: call("emojiPanel"),
  openWorker: call("openWorker"),
  stopWorker: call("stopWorker"),
  openRequest: call("openRequest"),
  setTray: call("setTray"),
  call: call("call") as Bridge["call"],
  secret: call("secret"),
  pickup: call("pickup"),
  slackShown: call("slackShown"),
  confirmReplace: call("confirmReplace"),
  exportArtifact: call("exportArtifact"),
  onEvent: (listener: (event: AppEvent) => void) => {
    const handle = (_event: unknown, payload: AppEvent) => listener(payload);
    ipcRenderer.on(eventChannel, handle);
    return () => {
      ipcRenderer.removeListener(eventChannel, handle);
    };
  },
};

contextBridge.exposeInMainWorld("openDot", bridge);
