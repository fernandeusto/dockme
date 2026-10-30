import { Router } from "express";
import jwt from "jsonwebtoken";
import { R } from "redbean-node";
import { shake256, SHAKE256_LENGTH } from "./password-hash";
import { JWTDecoded } from "./util-server";
import { DockgeServer } from "./dockge-server";
// @ts-ignore Shared with the Dockme API, outside the public config directory.
import { internalKey, equalSecret } from "../../custom/security.js";

export function dockmeAuth(server: DockgeServer) {
    const router = Router();
    router.get("/dockme-internal/auth", async (req, res) => {
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "");
        if (!local || !equalSecret(req.get("X-Dockme-Internal"), internalKey())) {
            res.sendStatus(403);
            return;
        }
        try {
            const token = (req.get("Authorization") || "").replace(/^Bearer /, "");
            const decoded = jwt.verify(token, server.jwtSecret, { algorithms: ["HS256"] }) as JWTDecoded;
            const user = await R.findOne("user", " username = ? AND active = 1 ", [decoded.username]);
            if (!user || decoded.h !== shake256(user.password, SHAKE256_LENGTH)) {
                res.sendStatus(401);
                return;
            }
            res.json({ username: user.username });
        } catch {
            res.sendStatus(401);
        }
    });
    return router;
}
