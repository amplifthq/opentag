import { expect, signIn, test } from "../fixtures.js";

const runId = process.env.OPENTAG_E2E_RUN_ID!;
const apiKeyLabel = `browser-e2e-${runId}`;

test("protects the console and authenticates the bootstrapped owner", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.getByRole("heading", {
    name: /Operate your runners without moving their workspaces/u,
  })).toBeVisible();

  await page.getByLabel("Email").fill(process.env.OPENTAG_E2E_ADMIN_EMAIL!);
  await page.getByLabel("Password").fill("wrong password value");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(
    "The email, password, or organization was not accepted.",
  )).toBeVisible();

  await signIn(page);
  const workspace = page.getByRole("main");
  for (const metric of ["Runners", "Ready", "Active runs", "Terminal runs", "Pending jobs"]) {
    await expect(workspace.getByText(metric, { exact: true })).toBeVisible();
  }

  await page.reload();
  await expect(page.getByRole("heading", { name: "Your AI teammates" })).toBeVisible();
  await page.getByRole("link", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
  await expect(page.getByRole("main").getByText(
    process.env.OPENTAG_E2E_ADMIN_EMAIL!,
  )).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await page.goto("/security");
  await expect(page).toHaveURL(/\/login$/u);
});

test("creates, persists, and revokes an API key through the real console", async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "API keys" }).click();
  await expect(page.getByRole("heading", { name: "API keys" })).toBeVisible();

  await expect(page.getByLabel("Allow governed permission decisions")).toHaveCount(0);
  await page.getByLabel("Key label").fill(apiKeyLabel);
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().endsWith("/api/console/api-keys")
      && response.request().method() === "POST"
      && response.status() === 201),
    page.getByRole("button", { name: "Create API key" }).click(),
  ]);
  await expect(page.getByText("Copy this token now.")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: apiKeyLabel });
  await expect(row).toContainText("run:read");
  await expect(row).not.toContainText("permission:resolve");
  await expect(row).toContainText("active");

  await page.reload();
  await expect(page.getByText("Copy this token now.")).toHaveCount(0);
  const persistedRow = page.getByRole("row").filter({ hasText: apiKeyLabel });
  await expect(persistedRow).toContainText("active");
  await persistedRow.getByRole("button", { name: "Revoke" }).click();
  await expect(persistedRow).toContainText("revoked");
});

test("keeps Project Target management read-only in the console", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.getByRole("link", { name: "Targets" }).click();
  await expect(page.getByText(/registered by the intended Runner/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Declare Project Target" })).toHaveCount(0);
  await expect(page.getByLabel("Binding digest")).toHaveCount(0);

  const rejected = await request.post("/api/console/api-keys", {
    headers: { origin: "https://untrusted.example" },
    data: { label: "forbidden", scopes: ["run:read"] },
  });
  expect(rejected.status()).toBe(403);
  expect(await rejected.json()).toEqual({ error: "forbidden_origin" });
});
