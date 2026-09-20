import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requireAuth, requireInitialized } from "./middleware";
import authRoutes from "./auth.routes";
import accountsRoutes from "./accounts.routes";
import holdingsRoutes from "./holdings.routes";
import portfolioRoutes from "./portfolio.routes";
import settingsRoutes from "./settings.routes";
import historyRoutes from "./history.routes";
import backupRoutes from "./backup.routes";
import quotesRoutes from "./quotes.routes";

const api = new Hono<AppEnv>();

// 认证接口自己判断是否已初始化（setup / params / me 必须在初始化前可用）
api.route("/auth", authRoutes);

// 其余接口：先要求已初始化，再要求已登录
const guarded = new Hono<AppEnv>();
guarded.use("*", requireInitialized);
guarded.use("*", requireAuth);
guarded.route("/accounts", accountsRoutes);
guarded.route("/holdings", holdingsRoutes);
guarded.route("/portfolio", portfolioRoutes);
guarded.route("/settings", settingsRoutes);
guarded.route("/history", historyRoutes);
guarded.route("/backup", backupRoutes);
guarded.route("/quotes", quotesRoutes);

api.route("/", guarded);

export default api;
