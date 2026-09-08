import { afterEach, expect, it, vi } from "vitest";
import { createControlClient } from "./control-client.ts";
import { createMcpBridgeInterceptor } from "./mcp-bridge.ts";

afterEach(() => vi.useRealTimers());

it("keeps a computer call pending until ownership is granted, without claiming on tool discovery", async () => {
  vi.useFakeTimers();
  let waiting = true;
  const fetchImpl = vi.fn(async () => Response.json({ held: false, helpOpen: false, waiting }));
  const client = createControlClient({ url: "http://127.0.0.1/control?botId=test", token: "test", fetchImpl });
  const forward = vi.fn();
  const answer = vi.fn();
  const intercept = createMcpBridgeInterceptor({
    forward, answer, gate: { isHeld: async (signal) => (await client.waitForComputer(signal)).held },
  });
  const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call" });
  intercept(list);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchImpl).not.toHaveBeenCalled();
  intercept(call);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(forward.mock.calls).toEqual([[list]]);
  expect(answer).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1/control?botId=test&acquire=1", expect.anything());
  waiting = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(forward.mock.calls).toEqual([[list], [call]]);
  expect(answer).not.toHaveBeenCalled();
});

it.each(["revoked", "human", "offline"])("stops waiting and refuses actions when %s", async (reason) => {
  vi.useFakeTimers();
  let waiting = true;
  const fetchImpl = vi.fn(async () => {
    if (waiting) return Response.json({ held: false, waiting: true });
    if (reason === "offline") throw new Error("connection closed");
    if (reason === "revoked") return new Response(null, { status: 401 });
    return Response.json({ held: true });
  });
  const client = createControlClient({ url: "http://127.0.0.1/control", token: "test", fetchImpl });
  const result = client.waitForComputer();
  await vi.advanceTimersByTimeAsync(500);
  waiting = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toMatchObject({ held: true });
});


it("cancels a queued MCP call without forwarding it after the desktop becomes free", async () => {
  vi.useFakeTimers();
  let waiting = true;
  const fetchImpl = vi.fn(async () => Response.json({ held: false, waiting }));
  const client = createControlClient({ url: "http://127.0.0.1/control", token: "test", fetchImpl });
  const forward = vi.fn();
  const answer = vi.fn();
  const intercept = createMcpBridgeInterceptor({
    forward, answer, gate: { isHeld: async (signal) => (await client.waitForComputer(signal)).held },
  });
  const call = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" });
  const cancel = JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
  intercept(call);
  await vi.advanceTimersByTimeAsync(500);
  intercept(cancel);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1/control?acquire=1", expect.objectContaining({ method: "DELETE" }));
  waiting = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(forward.mock.calls).toEqual([[cancel]]);
  expect(answer).not.toHaveBeenCalled();
});
