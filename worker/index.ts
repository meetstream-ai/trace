import { privateResponse } from "../lib/ingress";
import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

const worker = {
  async fetch(
    request: Request,
    env: Cloudflare.Env,
    ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>,
  ) {
    const url = new URL(request.url);
    const settings = env as Cloudflare.Env & { TRACE_PUBLIC_ORIGIN?: string };
    const canonical = settings.TRACE_PUBLIC_ORIGIN;
    const https = url.protocol === "https:";
    if (canonical && (!https || url.origin !== canonical))
      return privateResponse(
        new Response("Use the configured HTTPS origin.", { status: 421 }),
        https,
        false,
      );
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt)
            return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return {
              status: "request_context_expired",
              message: "This request has expired. Please try again.",
            };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    const response = await runWithConnectorBinding(binding, () =>
      handler.fetch(request, env, ctx),
    );
    return privateResponse(response, https, !!canonical);
  },
};

export default worker;
