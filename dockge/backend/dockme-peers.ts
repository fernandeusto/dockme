import { io } from "socket.io-client";
import { Agent } from "./models/agent";
// @ts-ignore Shared Dockme security helpers.
import { ensurePeer } from "../../custom/security.js";

// Reuse saved agent credentials at startup, without requiring an open browser.
export function pairPeer(url: string, username: string, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const client = io(url, { reconnection: false, timeout: 5000, extraHeaders: { endpoint: new URL(url).host } });
        const finish = (error?: Error) => {
            clearTimeout(timer);
            client.disconnect();
            if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => finish(new Error("Dockme pairing timed out")), 15000);
        client.on("connect_error", () => finish(new Error("Agent unavailable for Dockme pairing")));
        client.on("connect", () => {
            client.timeout(5000).emit("login", { username, password }, (error: Error | null, result: { ok?: boolean }) => {
                if (error || !result?.ok) return finish(new Error("Agent login rejected"));
                client.timeout(5000).emit("dockmePair", ensurePeer(url), (pairError: Error | null, paired: { ok?: boolean }) => {
                    finish(pairError || !paired?.ok ? new Error("Agent 3.8 required for authenticated HTTP") : undefined);
                });
            });
        });
    });
}

export async function pairConfiguredPeers() {
    const agents = await Agent.getAgentList();
    await Promise.all(Object.values(agents).map(async agent => {
        try { await pairPeer(agent.url, agent.username, agent.password); }
        catch (error) { console.warn(`[Dockme pairing] ${agent.endpoint}: ${(error as Error).message}`); }
    }));
}
