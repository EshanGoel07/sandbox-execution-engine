/**
 * Fans real-time submission updates out to WebSocket clients. There is
 * exactly ONE Redis subscriber connection for the whole server — not one per
 * WebSocket client — fanned out in-process to whichever sockets asked about a
 * given submissionId. The update only needs to reach this process once.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { SubmissionUpdate } from "@vj/shared";
import {
  subscribeToSubmissionUpdates,
  getSubmissionStatus,
  getSubmissionOwnerId,
} from "@vj/infra";
import { verifyToken } from "./auth/session";

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

    socket.on("message", async (raw) => {
      let msg: { type?: string; submissionId?: number; token?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "subscribe" || typeof msg.submissionId !== "number") return;

      // A subscription can leak a submission's status, verdict and per-test
      // breakdown, so it needs the same auth as GET /submissions/:id: a valid
      // session, scoped to the owner. The browser can't set headers on a
      // WebSocket, so the token rides in the subscribe frame.
      const userId = verifyToken(msg.token);
      if (userId === null) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "error", error: "authentication required" }));
        }
        return;
      }
      const ownerId = await getSubmissionOwnerId(msg.submissionId);
      if (ownerId === null || ownerId !== userId) {
        // Same as the REST side: don't distinguish "not yours" from "doesn't
        // exist".
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "error", error: "not found" }));
        }
        return;
      }

      subscribedTo = msg.submissionId;
      // Register for live updates FIRST, then fetch a catch-up snapshot —
      // if the job finishes in the gap between those two steps, the live
      // push still lands (this arm just also sends an extra, harmless
      // snapshot of the same terminal state).
      if (!subscribers.has(subscribedTo)) subscribers.set(subscribedTo, new Set());
      subscribers.get(subscribedTo)!.add(socket);

      const snapshot = await getSubmissionStatus(subscribedTo);
      if (snapshot && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(snapshot));
      }
    });

    socket.on("close", () => {
      if (subscribedTo !== null) subscribers.get(subscribedTo)?.delete(socket);
    });
  });

  return wss;
}
