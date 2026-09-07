/**
 * Fans real-time submission updates out to WebSocket clients. There is
 * exactly ONE Redis subscriber connection for the whole server — not one per
 * WebSocket client — fanned out in-process to whichever sockets asked about a
 * given submissionId. The update only needs to reach this process once.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { SubmissionUpdate } from "@vj/shared";
import { subscribeToSubmissionUpdates, getSubmissionStatus } from "@vj/infra";

export function attachWebSocketGateway(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const subscribers = new Map<number, Set<WebSocket>>();

  subscribeToSubmissionUpdates((update: SubmissionUpdate) => {
    const sockets = subscribers.get(update.submissionId);
    if (!sockets) return;
    const message = JSON.stringify(update);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  });

  wss.on("connection", (socket) => {
    let subscribedTo: number | null = null;

    socket.on("message", (raw) => {
      let msg: { type?: string; submissionId?: number };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "subscribe" && typeof msg.submissionId === "number") {
        subscribedTo = msg.submissionId;
        // Register for live updates FIRST, then fetch a catch-up snapshot —
        // if the job finishes in the gap between those two steps, the live
        // push still lands (this arm just also sends an extra, harmless
        // snapshot of the same terminal state).
        if (!subscribers.has(subscribedTo)) subscribers.set(subscribedTo, new Set());
        subscribers.get(subscribedTo)!.add(socket);

        getSubmissionStatus(subscribedTo).then((snapshot) => {
          if (snapshot && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(snapshot));
          }
        });
      }
    });

    socket.on("close", () => {
      if (subscribedTo !== null) subscribers.get(subscribedTo)?.delete(socket);
    });
  });

  return wss;
}
