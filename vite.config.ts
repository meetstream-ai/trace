import vinext from "vinext";
import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import hostingConfig from "./.openai/hosting.json" with { type: "json" };
import { localDatabase } from "./scripts/migrate-local.mjs";
import { readExecutionProfile } from "./scripts/execution-profile.mjs";
import { configureToolEnvironment } from "./scripts/tool-environment.mjs";
import { sites } from "./scripts/vite/sites-vite-plugin.ts";
import { connectorPreview } from "./scripts/vite/connector-preview-plugin.mjs";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const managedLinux = readExecutionProfile() === "managed-linux";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1 ? [{ ...localDatabase, binding: d1 }] : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ command }) => {
  configureToolEnvironment(process.cwd());
  const enableConnectorPreview =
    command === "serve" && process.env.TRACE_ENABLE_CONNECTOR_PREVIEW === "1";
  const localEnv =
    command === "serve"
      ? Object.assign(
          {},
          ...[
            ".env",
            ".env.local",
            ".env.development",
            ".env.development.local",
          ]
            .filter((file) => existsSync(file))
            .map((file) => parseEnv(readFileSync(file, "utf8"))),
        )
      : {};
  const localKeys = [
    "APP_PASSWORD",
    "TRACE_PUBLIC_ORIGIN",
    "TRACE_PAUSE_PUBLISHING",
    "TRACE_WEBHOOK_ENDPOINTS",
    "APP_SESSION_SECRET",
    "MEETSTREAM_API_KEY",
    "TRACE_MEETING_AGENT_ORIGIN",
    "TRACE_MEETING_AGENT_ID",
    "TRACE_MEETING_AGENT_LIVE_TOKEN",
    "TRACE_MEETING_AGENT_WORKSPACE",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "LINEAR_API_KEY",
    "LINEAR_TEAM_ID",
    "LINEAR_ASSIGNEES",
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_ASSIGNEES",
    "SLACK_WEBHOOK_URL",
    "NOTION_API_KEY",
    "NOTION_PARENT_PAGE_ID",
  ];

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    envPrefix: [],
    server: {
      host: "127.0.0.1",
      strictPort: true,
      watch: { ignored: ["**/.sites-runtime/**"] },
      fs: {
        deny: [
          ".env",
          ".env.*",
          "**/.git/**",
          "**/.sites-runtime/**",
          ".dev.vars",
          ".dev.vars.*",
          ".npmrc",
          ".yarnrc.yml",
          "*.{crt,pem,key,p12,pfx,cer,der}",
          "*.{db,sqlite,sqlite3}{,-wal,-shm,-journal}",
          "**/.next/**",
          "**/.vinext/**",
          `${process.cwd()}/dist/server/**`,
          "**/.wrangler/**",
          "**/meeting-agent/.state/**",
          "**/outputs/**",
          "**/.openai/**",
        ],
      },
      ...(managedLinux
        ? { host: "0.0.0.0", allowedHosts: ["terminal.local"] }
        : {}),
      ...(isCodexSeatbeltSandbox
        ? {
            watch: {
              ignored: ["**/.sites-runtime/**"],
              useFsEvents: false,
              usePolling: true,
            },
          }
        : {}),
    },
    plugins: [
      vinext(),
      sites({ mockAuth: false }),
      ...(enableConnectorPreview ? [connectorPreview()] : []),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        remoteBindings: false,
        config: {
          ...localBindingConfig,
          ...(command === "serve"
            ? {
                vars: {
                  ...Object.fromEntries(
                    localKeys
                      .map((key) => [key, process.env[key] ?? localEnv[key]])
                      .filter(([, value]) => value),
                  ),
                  ...(!managedLinux ? { TRACE_LOCAL_BOOTSTRAP: "1" } : {}),
                },
              }
            : {}),
          ...(enableConnectorPreview
            ? {
                services: [
                  {
                    binding: "CONNECTORS",
                    service: "sites-connector-preview",
                    entrypoint: "ConnectorPreview",
                  },
                ],
              }
            : {}),
        },
        ...(enableConnectorPreview
          ? {
              auxiliaryWorkers: [
                {
                  config: {
                    name: "sites-connector-preview",
                    main: "./scripts/connector-preview/worker.mjs",
                    compatibility_date: "2026-05-15",
                  },
                },
              ],
            }
          : {}),
      }),
    ],
  };
});
