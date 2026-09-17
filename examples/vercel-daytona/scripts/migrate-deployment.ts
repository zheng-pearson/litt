// Production builds use their existing secret bindings; secrets never leave Vercel.
if (process.env.APPLY_LEGAL_GUIDANCE === "true") {
  await import("./update-legal-guidance.js");
}
if (process.env.APPLY_HEARTBEAT_GUIDANCE === "true") {
  const { applyHeartbeatGuidance } = await import("./update-heartbeat-guidance.js");
  await applyHeartbeatGuidance();
}
if (process.env.PREFLIGHT_RUNTIME_HEALTH === "true") {
  await import("./runtime-health-upgrade.js");
}
if (process.env.INSPECT_DEMO_RUNTIME === "true") {
  await import("./inspect-runtime-deployment.js");
}
if (process.env.APPLY_DEMO_SCHEMA === "true") {
  if (process.env.VERCEL_ENV !== "production") {
    throw new Error("The deployment migration requires the production environment");
  }
  await import("./migrate.js");
}

export {};
