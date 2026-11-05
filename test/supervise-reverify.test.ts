import { expect, spyOn, test } from "bun:test";
import { Service } from "@opencode/client/service";
import { Effect } from "effect";
import { OpenCode } from "../src/opencode";

const owner = "ses_reverify";
const idle = (id: string, created: number) => ({
  id,
  type: "idle",
  outcome: "succeeded",
  time: { created },
});
const assistant = (id: string, created: number, text: string) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "anthropic" },
  content: text ? [{ type: "text", text }] : [],
  time: { created },
});
async function withAdapter(
  handler: (url: URL) => Response,
  run: (service: OpenCode["Service"]) => Promise<void>,
) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => handler(new URL(request.url)),
  });
  const discover = spyOn(Service, "discover").mockResolvedValue({
    url: server.url.href,
    auth: undefined,
  });
  try {
    await run(await Effect.runPromise(OpenCode.pipe(Effect.provide(OpenCode.layer))));
  } finally {
    discover.mockRestore();
    await server.stop(true);
  }
}

test("issue27 reverify public adapter: timestamp ties span cursor pages without truncation", async () => {
  const history = [
    ...Array.from({ length: 60 }, (_, i) => idle(`msg_new${i}`, 200)),
    ...Array.from({ length: 60 }, (_, i) => idle(`msg_boundary${i}`, 100)),
    idle("msg_before", 99),
  ];
  let idlePages = 0;
  await withAdapter(
    (url) => {
      expect(url.pathname).toBe(`/api/session/${owner}/message`);
      if (url.searchParams.get("type") === "assistant")
        return Response.json({ data: [], cursor: {} });
      idlePages++;
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      expect(url.searchParams.get("limit")).toBe("50");
      expect(url.searchParams.has("order")).toBe(offset === 0);
      return Response.json({
        data: history.slice(offset, offset + 50),
        cursor: offset + 50 < history.length ? { next: String(offset + 50) } : {},
      });
    },
    async (service) => {
      const ends = await Effect.runPromise(service.turnsSince(owner, 100));
      expect(ends).toHaveLength(120);
      expect(new Set(ends.map((item) => item.id)).size).toBe(120);
      expect(ends.filter((item) => item.time === 100)).toHaveLength(60);
      expect(ends.some((item) => item.id === "msg_before")).toBe(false);
      expect(idlePages).toBe(3);
    },
  );
});

test("issue27 reverify public adapter: every paginated old turn retains its final assistant excerpt", async () => {
  const idles = [
    ...Array.from({ length: 80 }, (_, i) => idle(`msg_end${i}`, 100 + i * 10)).toReversed(),
    idle("msg_before", 80),
  ];
  const replies = [
    assistant("msg_current", 1000, "Still working"),
    ...Array.from({ length: 80 }, (_, i) =>
      assistant(`msg_reply${i}`, 99 + i * 10, `Final ${i}`),
    ).toReversed(),
    assistant("msg_ancient", 70, "Before binding"),
  ];
  let assistantPages = 0;
  await withAdapter(
    (url) => {
      expect(url.pathname).toBe(`/api/session/${owner}/message`);
      const isAssistant = url.searchParams.get("type") === "assistant";
      if (isAssistant) assistantPages++;
      const history = isAssistant ? replies : idles;
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      return Response.json({
        data: history.slice(offset, offset + 50),
        cursor: offset + 50 < history.length ? { next: String(offset + 50) } : {},
      });
    },
    async (service) => {
      const ends = await Effect.runPromise(service.turnsSince(owner, 90));
      expect(ends).toHaveLength(80);
      for (let i = 0; i < 80; i++)
        expect(ends[i]).toMatchObject({ id: `msg_end${i}`, text: `Final ${i}` });
      expect(assistantPages).toBe(2);
    },
  );
});

test("issue27 reverify public adapter: repeating an assistant cursor fails rather than publishes partial data", async () => {
  let assistantPages = 0;
  await withAdapter(
    (url) => {
      if (url.searchParams.get("type") === "idle")
        return Response.json({ data: [idle("msg_end", 1000)], cursor: {} });
      assistantPages++;
      return Response.json({
        data: Array.from({ length: 50 }, (_, i) => assistant(`msg_blank${i}`, 900 - i, "")),
        cursor: { next: "repeat" },
      });
    },
    async (service) => {
      const result = await Effect.runPromise(
        Effect.result(service.turnsSince(owner, 0)).pipe(Effect.timeout("2 seconds")),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          cause: { message: `OpenCode returned the same history page of ${owner} twice` },
        },
      });
      expect(assistantPages).toBe(2);
    },
  );
});
