import { generateId } from "./uuid.js";

export function createPeerId() {
  return generateId();
}

export function createRoomId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createSignalingClient({ baseUrl, roomId, peerId, name, role, canHost = false }) {
  const url = new URL(`/room/${encodeURIComponent(roomId)}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("peerId", peerId);
  url.searchParams.set("name", name);
  url.searchParams.set("role", role);
  url.searchParams.set("canHost", canHost ? "true" : "false");

  const socket = new WebSocket(url.toString());
  const listeners = new Map();

  socket.addEventListener("message", (event) => {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    const typeListeners = listeners.get(message.type) || [];
    const allListeners = listeners.get("*") || [];

    [...typeListeners, ...allListeners].forEach((listener) => listener(message));
  });

  return {
    socket,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    on(type, listener) {
      const typeListeners = listeners.get(type) || [];
      listeners.set(type, [...typeListeners, listener]);

      return () => {
        listeners.set(
          type,
          (listeners.get(type) || []).filter((current) => current !== listener)
        );
      };
    },
    close() {
      socket.close();
      listeners.clear();
    },
  };
}
