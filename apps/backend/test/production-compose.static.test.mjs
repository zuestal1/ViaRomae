import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

const documentedEnvironment = {
  ...process.env,
  DATABASE_URL: "postgresql://postgres:secret@postgres:5432/jugendleiter2026",
  POSTGRES_PASSWORD: "secret",
  JWT_SECRET: "static-test-secret-at-least-32-characters",
  VITE_API_BASE_URL: "https://api.jlw2026.example.com",
  VITE_MAPTILER_API_KEY: "static-test-key",
  VITE_GM_CLIENT_URL: "https://gm.jlw2026.example.com",
  FRONTEND_ORIGIN: "https://jlw2026.example.com",
  GM_FRONTEND_ORIGIN: "https://gm.jlw2026.example.com",
  ROSTER_FILE: "/srv/via-romae-secrets/roster.production.json",
  ROSTER_SHA256: "0".repeat(64),
  EXPECTED_PLAYER_COUNT: "13",
  EXPECTED_TEAM_COUNT: "4",
};

function resolveCompose(storageProvider) {
  const files = ["docker-compose.production.yml"];
  const environment = { ...documentedEnvironment, STORAGE_PROVIDER: storageProvider };

  if (storageProvider === "aws") {
    Object.assign(environment, {
      S3_ENDPOINT: "https://s3.eu-central-1.amazonaws.com",
      S3_PUBLIC_ENDPOINT: "https://s3.eu-central-1.amazonaws.com",
      S3_FORCE_PATH_STYLE: "false",
      S3_BUCKET: "jlw2026-media-production",
      S3_REGION: "eu-central-1",
      S3_ACCESS_KEY_ID: "static-test-aws-access-key",
      S3_SECRET_ACCESS_KEY: "static-test-aws-secret-key",
    });
  } else {
    files.push("docker-compose.production.minio.yml");
    Object.assign(environment, {
      S3_ENDPOINT: "http://minio:9000",
      S3_PUBLIC_ENDPOINT: "https://media.jlw2026.example.com",
      S3_FORCE_PATH_STYLE: "true",
      S3_BUCKET: "via-romae-media",
      S3_REGION: "eu-central-1",
      S3_ACCESS_KEY_ID: "static-test-minio-user",
      S3_SECRET_ACCESS_KEY: "static-test-minio-password",
      MINIO_ROOT_USER: "static-test-minio-user",
      MINIO_ROOT_PASSWORD: "static-test-minio-password",
    });
  }

  const arguments_ = ["compose"];
  for (const file of files) arguments_.push("-f", file);
  arguments_.push("config", "--format", "json");

  const result = spawnSync("docker", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

const dependenciesOf = (model, service) => Object.keys(model.services[service].depends_on ?? {});

test("the resolved AWS production model contains no MinIO services or dependencies", () => {
  const model = resolveCompose("aws");

  assert.equal(model.services.minio, undefined);
  assert.equal(model.services["minio-init"], undefined);
  for (const service of Object.keys(model.services)) {
    assert.ok(!dependenciesOf(model, service).some((dependency) => dependency.startsWith("minio")));
  }
});

test("the resolved MinIO production model contains bucket initialization and the complete release chain", () => {
  const model = resolveCompose("minio");

  assert.ok(model.services.minio);
  assert.ok(model.services["minio-init"]);
  assert.deepEqual(dependenciesOf(model, "minio-init"), ["minio"]);
  assert.ok(dependenciesOf(model, "release-preflight").includes("minio-init"));
  assert.ok(dependenciesOf(model, "release-preflight").includes("roster-import"));
  assert.ok(dependenciesOf(model, "roster-import").includes("seed-content"));
  assert.ok(dependenciesOf(model, "seed-content").includes("migrate"));
  assert.ok(dependenciesOf(model, "migrate").includes("postgres"));
  assert.ok(dependenciesOf(model, "backend").includes("release-preflight"));
  assert.ok(dependenciesOf(model, "backend").includes("minio"));
  assert.ok(!dependenciesOf(model, "backend").includes("minio-init"));
});
