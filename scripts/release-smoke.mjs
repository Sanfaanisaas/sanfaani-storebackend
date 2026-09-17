const base = process.env.RELEASE_SMOKE_BASE_URL;
if (!base || !/^https:\/\//.test(base)) throw new Error("RELEASE_SMOKE_BASE_URL must be an HTTPS API origin");
for (const path of ["/api/health", "/api/ready"]) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Release smoke failed for ${path}: HTTP ${response.status}`);
  const body = await response.json(); if (!body.success) throw new Error(`Release smoke failed for ${path}: unsuccessful envelope`);
}
process.stdout.write("release smoke passed\n");
