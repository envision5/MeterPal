import { Hono } from "hono";
import type { HonoEnv } from "@/honoUtils/HonoEnv";

/**
 * The DFU billing import endpoint is gone — it imported processor payment
 * state that no longer exists. The router is kept so the RPC mount point stays
 * stable.
 */
export const dfuRpcRouter = new Hono<HonoEnv>();
