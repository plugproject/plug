import { test, expect } from '@playwright/test';
test('own inputs, recomputation, strict requirements, downloads and mobile layout', async ({
  page,
}) => {
  await page.goto('/');
  await page.screenshot({ path: 'test-results/plug-desktop.png' });
  await expect(
    page.getByRole('heading', { name: 'Design for the experience.' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Suggest design', exact: true })
    .click();
  await expect(
    page.getByText(
      'A design meets the stated requirements under its assumptions.',
    ),
  ).toBeVisible();
  await page.getByLabel('Maximum result age (ms)').fill('5000');
  await expect(
    page.getByRole('button', { name: '↓ Design JSON' }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Suggest design', exact: true })
    .click();
  await expect(
    page.getByText(
      'No feasible candidate under the supplied facts and supported catalog.',
    ),
  ).toBeVisible();
  await page.getByLabel('Maximum result age (ms)').fill('90000');
  await page.getByLabel('System name').nth(1).fill('My downstream service');
  await page
    .getByRole('button', { name: 'Suggest design', exact: true })
    .click();
  await expect(
    page.getByText(
      'A design meets the stated requirements under its assumptions.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Start scheduled-cache', exact: true }),
  ).toBeDisabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '↓ Implementation recipe' }).click();
  expect((await download).suggestedFilename()).toBe('design.md');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#designs').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/plug-mobile.png' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test('full-speed real warmup, changed source version after later refresh, then cancellation', async ({
  page,
}) => {
  test.setTimeout(110000);
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Suggest design', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Start scheduled-cache', exact: true })
    .click();
  await expect(page.getByRole('log')).toContainText(
    'Warmup attempts completed',
    { timeout: 25000 },
  );
  await page
    .getByRole('button', { name: 'Request DEL → LHR', exact: true })
    .click();
  await expect(page.getByRole('log')).toContainText('cache hit');
  await expect(page.getByRole('log')).toContainText('"version": 1');
  await page
    .getByRole('button', { name: 'Change source data', exact: true })
    .click();
  // The first hot key really refreshes at 60 seconds and completes after 15 more.
  await expect
    .poll(
      async () =>
        page
          .getByRole('log')
          .getByText('refresh success', { exact: true })
          .count(),
      { timeout: 70000, intervals: [1000] },
    )
    .toBeGreaterThanOrEqual(4);
  await page
    .getByRole('button', { name: 'Request DEL → LHR', exact: true })
    .click();
  await expect(page.getByRole('log')).toContainText('"version": 2');
  await page.getByRole('button', { name: 'Expire cache', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'cancelled' }),
  ).toBeVisible();
});

test('metadata review and canonical validation work without runtime script evaluation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByText('Import MCP / A2A metadata', { exact: true }).click();
  await page.getByLabel('Pasted metadata').fill(
    JSON.stringify({
      serverId: 'own-mcp',
      protocolVersion: '2025-11-25',
      response: {
        tools: [
          {
            name: 'lookup',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    }),
  );
  await page.getByRole('button', { name: 'Review extracted facts' }).click();
  await expect(page.getByRole('heading', { name: 'own-mcp' })).toBeVisible();
  await expect(page.locator('.import-review')).toContainText(
    'output schema missing',
  );
  await page.getByRole('button', { name: 'Use as downstream system' }).click();
  await page
    .getByRole('button', { name: 'Suggest design', exact: true })
    .click();
  await expect(
    page.getByText(
      'No feasible candidate under the supplied facts and supported catalog.',
    ),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
