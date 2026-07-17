#!/usr/bin/env bash
set -euo pipefail

image="onestepchess:release1-smoke"
suffix="$$"
container="osc-release1-smoke-${suffix}"
volume="osc-release1-smoke-${suffix}"
runtime_secret="docker-smoke-runtime-secret-0123456789"
banner="internal playtest — no real USDC"

cleanup() {
  docker rm --force "${container}" >/dev/null 2>&1 || true
  docker volume rm "${volume}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --tag "${image}" .
docker volume create "${volume}" >/dev/null
docker run --detach \
  --name "${container}" \
  --mount "source=${volume},target=/data" \
  --publish "127.0.0.1::3000" \
  --env "JWT_SECRET=${runtime_secret}" \
  --env "PUBLIC_BASE_URL=http://localhost:3000" \
  --env "SYSTEM_BANNER=${banner}" \
  "${image}" >/dev/null

for _ in $(seq 1 45); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "${container}")" = "healthy" ]; then
    break
  fi
  sleep 1
done
if [ "$(docker inspect --format '{{.State.Health.Status}}' "${container}")" != "healthy" ]; then
  docker logs "${container}"
  exit 1
fi

host_port="$(docker port "${container}" 3000/tcp)"
host_port="${host_port##*:}"
node --input-type=module --eval "
  const health = await fetch('http://127.0.0.1:${host_port}/healthz').then((response) => response.json());
  if (health.status !== 'ok') throw new Error('health check failed');
  const meta = await fetch('http://127.0.0.1:${host_port}/api/v1/meta').then((response) => response.json());
  if (meta.status.banner !== '${banner}') throw new Error('playtest banner missing');
"
docker logs "${container}" 2>&1 | \
  OSC_EXPECT_SECRET="${runtime_secret}" node --input-type=module --eval '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const forbidden = [
      process.env.OSC_EXPECT_SECRET,
      "PAYMENT-SIGNATURE",
      "TREASURY_MNEMONIC=",
      "ADMIN_TOKEN=",
    ].filter(Boolean);
    if (forbidden.some((value) => input.includes(value))) {
      throw new Error("secret-shaped value found in container logs");
    }
    for (const line of input.trim().split("\n").filter(Boolean)) JSON.parse(line);
  '

docker exec "${container}" node --input-type=module --eval '
  import Database from "/app/packages/server/node_modules/better-sqlite3/lib/index.js";
  const db = new Database("/data/osc.sqlite");
  const now = Date.now();
  db.prepare(`
    INSERT INTO games (
      id, name, status, fen, ply, history_json, rules_json, result,
      termination, min_next_claim_at, last_ply_at, created_at, finished_at,
      resolved_at
    ) VALUES (
      @id, @name, @status, @fen, 2, @history, @rules, @result,
      @termination, 0, @now, @now, @now, @now
    )
  `).run({
    id: "gm_docker_restart_evidence",
    name: "docker-restart-evidence",
    status: "finished",
    fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
    history: JSON.stringify(["e2e4", "e7e5"]),
    rules: "{}",
    result: "white",
    termination: "checkmate",
    now,
  });
  db.close();
'

docker stop "${container}" >/dev/null
docker start "${container}" >/dev/null
for _ in $(seq 1 45); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "${container}")" = "healthy" ]; then
    break
  fi
  sleep 1
done
if [ "$(docker inspect --format '{{.State.Health.Status}}' "${container}")" != "healthy" ]; then
  docker logs "${container}"
  exit 1
fi

docker exec "${container}" node --input-type=module --eval '
  import Database from "/app/packages/server/node_modules/better-sqlite3/lib/index.js";
  const db = new Database("/data/osc.sqlite", { readonly: true });
  const row = db.prepare("SELECT status, history_json AS history FROM games WHERE id = ?").get("gm_docker_restart_evidence");
  if (row?.status !== "finished" || row.history !== JSON.stringify(["e2e4", "e7e5"])) {
    throw new Error("finished-game history did not survive restart");
  }
  db.close();
'

if {
  docker history --no-trunc "${image}"
  docker image inspect --format '{{json .Config.Env}} {{json .Config.Cmd}}' "${image}"
} | grep --fixed-strings "${runtime_secret}" >/dev/null; then
  echo "runtime secret found in image metadata" >&2
  exit 1
fi

echo "Docker smoke passed: fresh migration, health, banner, structured secret-free logs, restart persistence, and image secret inspection."
