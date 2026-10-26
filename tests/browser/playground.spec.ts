import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fixtureTools,
  startMcpFixture,
  startRoutes,
} from '../fixtures/discovery-servers';
import {
  flightInput,
  keys,
  synthetic,
} from '../../packages/plug/src/demo/flight';
const operationNode = (page: Page, id: string) =>
  page.locator('.react-flow__node', {
    has: page.getByRole('button', { name: `Operation ${id}`, exact: true }),
  });
const systemGroup = (page: Page, name: string) =>
  page.locator('.react-flow__node', {
    has: page.getByRole('button', { name: `System ${name}`, exact: true }),
  });
const systemCount = (page: Page, value: number) =>
  page.getByText(new RegExp(`^${value} systems? ·`));
const connectionCount = (page: Page, value: number) =>
  page.getByText(new RegExp(`· ${value} connections?$`));
async function addWithoutInspection(page: Page) {
  const disclosure = page.getByRole('dialog', {
    name: 'Add integration host?',
  });
  await expect(disclosure).toBeVisible();
  await disclosure
    .getByRole('button', { name: 'Add without inspecting' })
    .click();
  await expect(disclosure).toHaveCount(0);
}
/** The box of `locator` once a new layout and fitting the view have stopped moving it. */
async function settledBox(locator: Locator) {
  let seen: string[] = [];
  await expect
    .poll(
      async () => {
        seen = [...seen.slice(-2), JSON.stringify(await locator.boundingBox())];
        return seen.length === 3 && new Set(seen).size === 1;
      },
      { intervals: [100] },
    )
    .toBe(true);
  return JSON.parse(seen[2]) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
/** A pointer position over bare canvas where something of `size`, held at `grab`, lands clear of every system. */
async function emptySpot(
  page: Page,
  size = { width: 8, height: 8 },
  grab = { x: 4, y: 4 },
) {
  return page.locator('.wf-canvas').evaluate(
    (canvas, { size, grab }) => {
      const c = canvas.getBoundingClientRect();
      const groups = [
        ...canvas.querySelectorAll('.react-flow__node-system'),
      ].map((g) => g.getBoundingClientRect());
      // Stay away from the edges, where dragging pans the view.
      for (let y = c.bottom - 60; y > c.top + 60; y -= 16)
        for (let x = c.left + 60; x < c.right - 60; x += 16) {
          const r = {
            left: x - grab.x - 8,
            top: y - grab.y - 8,
            right: x - grab.x + size.width + 8,
            bottom: y - grab.y + size.height + 8,
          };
          const clear =
            r.left > c.left &&
            r.right < c.right &&
            r.top > c.top &&
            r.bottom < c.bottom &&
            groups.every(
              (g) =>
                r.right < g.left ||
                g.right < r.left ||
                r.bottom < g.top ||
                g.bottom < r.top,
            );
          if (
            clear &&
            document
              .elementFromPoint(x, y)
              ?.classList.contains('react-flow__pane')
          )
            return { x, y };
        }
      throw new Error('No bare canvas left');
    },
    { size, grab },
  );
}
/** Drags a node by its body; `check` runs while it is still held over the target. */
async function dragNode(
  page: Page,
  node: Locator,
  to: { x: number; y: number } | 'empty',
  check?: () => Promise<void>,
) {
  const box = await settledBox(node);
  const grab = { x: 40, y: box.height / 2 };
  const end = to === 'empty' ? await emptySpot(page, box, grab) : to;
  await page.mouse.move(box.x + grab.x, box.y + grab.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 15 });
  await check?.();
  await page.mouse.up();
}
const centre = async (locator: Locator) => {
  const box = await settledBox(locator);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 + 10 };
};
/** Draws a connection from the + after `from` and drops it anywhere on the card of `to`. */
async function drag(page: Page, from: string, to: string) {
  await page.locator('.wf-canvas').scrollIntoViewIfNeeded();
  const start = await settledBox(
    operationNode(page, from).locator('[data-handleid="plus-out"]'),
  );
  const end = await settledBox(
    page.getByRole('button', { name: `Operation ${to}`, exact: true }),
  );
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
}
const foreignWorkflow = `document:
  dsl: 1.0.3
  namespace: shop
  name: buy-pet
  version: 1.0.0
do:
  - findPet:
      call: http
      with:
        method: get
        endpoint: https://petstore.swagger.io/v2/pet/1
  - checkStock:
      call: mcp
      with:
        method: tools/call
        parameters:
          name: stock
        transport:
          http:
            endpoint: https://tools.example.com/mcp
`;
test('own inputs, recomputation, strict requirements, downloads and mobile layout', async ({
  page,
}) => {
  await page.goto('/');
  await page.screenshot({ path: 'test-results/plug-desktop.png' });
  await expect(
    page.getByRole('heading', { name: 'Design workbench' }),
  ).toBeVisible();
  // The workbench is the first screen: the canvas starts within the first viewport.
  expect(
    (await page.locator('.wf-canvas').boundingBox())!.y,
  ).toBeLessThanOrEqual(page.viewportSize()!.height);
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
  await page
    .getByRole('button', { name: 'System Slow flight aggregator', exact: true })
    .click();
  await page.getByLabel('System name').fill('My downstream service');
  await expect(
    page.getByRole('button', {
      name: 'System My downstream service',
      exact: true,
    }),
  ).toBeVisible();
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
test('multi-system intake, per-connection goals, priorities and frontier proofs', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#workspace')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Suggest design', exact: true })
    .click();
  const frontier = page.getByRole('list', { name: 'Architecture frontier' });
  await expect(frontier).toContainText('scheduled-cache');
  await expect(frontier.locator('.architecture-row.selected')).toContainText(
    'Engine selected',
  );
  await frontier.getByText('Proof').first().click();
  await expect(frontier).toContainText('Because');
  await page.getByRole('button', { name: 'Raise Simplicity' }).click();
  await expect(
    page.getByRole('list', { name: 'Priority order' }),
  ).toContainText(/Latency.*Simplicity.*Availability/);
  await page.getByRole('button', { name: '+ Add system' }).click();
  await expect(systemCount(page, 3)).toBeVisible();
  await expect(page.getByLabel('System name')).toHaveValue('New system');
  await page.getByRole('button', { name: '+ Add connection' }).click();
  await page
    .getByRole('button', { name: 'Operation find-options', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Operation operation', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: /^connection/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('button', { name: 'Connection connection', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Source latency (ms)')).toHaveValue('');
  await page
    .getByRole('button', { name: 'Suggest design', exact: true })
    .click();
  const results = page.getByRole('group', { name: 'Connection results' });
  await expect(results).toContainText('primary');
  await expect(
    page.getByText(
      'No feasible candidate under the supplied facts and supported catalog.',
    ),
  ).toBeVisible();
  await results.getByRole('button', { name: /^primary/ }).click();
  await expect(
    page.getByText(
      'A design meets the stated requirements under its assumptions.',
    ),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#workflow').scrollIntoViewIfNeeded();
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
  await page
    .getByText('Import MCP / A2A / OpenAPI metadata', { exact: true })
    .click();
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
test('workflow canvas: drag to connect, delete by keyboard and OpenSpec round trip', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: '+ Add system' }).click();
  await expect(operationNode(page, 'operation')).toBeVisible();
  await drag(page, 'find-options', 'operation');
  await expect(connectionCount(page, 2)).toBeVisible();
  await expect(page.getByLabel('Downstream system')).toHaveValue('system');
  await expect(page.getByLabel('Source latency (ms)')).toHaveValue('');
  // Edges never join operations of one system or repeat a pair.
  await drag(page, 'find-options', 'operation');
  await expect(connectionCount(page, 2)).toBeVisible();
  await page
    .getByRole('button', { name: 'Connection connection', exact: true })
    .focus();
  await page.keyboard.press('Delete');
  await expect(connectionCount(page, 1)).toBeVisible();
  await drag(page, 'find-options', 'operation');
  await expect(connectionCount(page, 2)).toBeVisible();
  await page
    .getByRole('button', { name: 'Connection primary', exact: true })
    .click();
  await page.getByRole('button', { name: 'Raise Latency' }).click();
  await page
    .getByRole('button', { name: 'Suggest design', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Connection primary', exact: true }),
  ).not.toContainText('not analyzed');
  await expect(
    page.getByRole('button', { name: 'Connection primary', exact: true }),
  ).toContainText('Correctness › Latency › Cost');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '↓ Download OpenSpec' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('workflow.yaml');
  const exported = readFileSync((await file.path())!, 'utf8');
  expect(exported).toContain('dsl: 1.0.3');
  expect(exported).toContain('designHash');
  const upload = page.getByLabel('Upload OpenSpec workflow');
  await upload.setInputFiles({
    name: 'workflow.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(exported),
  });
  const review = page.getByRole('region', { name: 'Workflow import review' });
  await expect(review).toContainText('Plug export, restored exactly');
  await review.getByRole('button', { name: 'Replace workflow' }).click();
  await expect(
    page.getByText('Loaded 3 systems and 2 connections from workflow.yaml.'),
  ).toBeVisible();
  await upload.setInputFiles({
    name: 'buy-pet.yaml',
    mimeType: 'application/yaml',
    buffer: Buffer.from(foreignWorkflow),
  });
  await expect(review).toContainText('unknown facts stay unknown');
  await expect(review).toContainText('findpet: drafted from task findPet');
  await review.getByRole('button', { name: 'Replace workflow' }).click();
  await expect(page.getByRole('tab', { name: /^findpet/ })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Connection checkstock', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Source latency (ms)')).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#workflow').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/plug-workflow-mobile.png' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test('inline editing, rewiring an edge and a visible inspector', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 960, height: 900 });
  await page.goto('/');
  await page.locator('.wf-canvas').scrollIntoViewIfNeeded();
  const canvas = (await page.locator('.wf-canvas').boundingBox())!;
  const inspector = (await page.locator('#inspector').boundingBox())!;
  expect(inspector.x).toBeGreaterThanOrEqual(canvas.x + canvas.width);
  await page
    .getByRole('button', { name: 'Operation search', exact: true })
    .dblclick();
  const rename = page.getByLabel('Rename operation search');
  await rename.fill('bad id!');
  await rename.press('Enter');
  await expect(page.locator('.wf-inline [role=alert]')).toContainText(
    'Operation IDs use',
  );
  await rename.fill('lookup');
  await rename.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Operation lookup', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('#inspector').getByRole('heading', { name: 'lookup' }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: /^primary/ })).toBeVisible();
  await page
    .getByRole('button', { name: 'System Slow flight aggregator', exact: true })
    .dblclick();
  await page
    .getByLabel('Rename system Slow flight aggregator')
    .fill('Fare service');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'System Fare service', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Connection primary', exact: true })
    .dblclick();
  const latency = page.getByLabel('Latency target for primary (ms)');
  await latency.fill('1500');
  await latency.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Connection primary', exact: true }),
  ).toContainText('≤ 1,500 ms');
  await page
    .getByRole('button', { name: 'Connection primary', exact: true })
    .click();
  await expect(page.getByLabel('Latency target (ms)')).toHaveValue('1500');
  await page.getByRole('button', { name: '+ Add system' }).click();
  await expect(operationNode(page, 'operation')).toBeVisible();
  await page.locator('.wf-canvas').scrollIntoViewIfNeeded();
  const end = await settledBox(
    operationNode(page, 'lookup').locator('[data-handleid="in"]'),
  );
  const target = await settledBox(
    operationNode(page, 'operation').locator('[data-handleid="in"]'),
  );
  await page.mouse.move(end.x - 3, end.y + end.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect(page.getByRole('tab', { name: /^primary/ })).toContainText(
    'Flight-search agent → New system',
  );
  await expect(page.getByLabel('Source latency (ms)')).toHaveValue('');
  await page.setViewportSize({ width: 700, height: 900 });
  await page
    .getByRole('button', { name: 'Operation lookup', exact: true })
    .click();
  await page.getByRole('button', { name: 'Edit lookup ↓' }).click();
  await expect(
    page.locator('#inspector').getByRole('heading', { name: 'lookup' }),
  ).toBeInViewport();
  expect(errors).toEqual([]);
});
test('on-canvas buttons add and remove elements; an edge drop spawns a system', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('.wf-canvas').scrollIntoViewIfNeeded();
  await expect(page.locator('.react-flow__controls')).toBeVisible();
  await expect(page.locator('.react-flow__minimap')).toBeVisible();
  // + on a system group adds an operation and focuses it in the inspector.
  await page
    .getByRole('button', {
      name: 'Add operation to Flight-search agent',
      exact: true,
    })
    .click();
  await expect(operationNode(page, 'operation')).toBeVisible();
  await expect(page.locator('#inspector')).toContainText(
    'On Flight-search agent',
  );
  // + on the new operation lists its free partners; choosing one connects it.
  await page
    .getByRole('button', { name: 'Connect operation', exact: true })
    .click();
  await page
    .getByRole('menu', { name: 'Connect operation to' })
    .getByRole('menuitem', { name: '→ Slow flight aggregator · search' })
    .click();
  await expect(connectionCount(page, 2)).toBeVisible();
  await expect(page.getByLabel('Source latency (ms)')).toHaveValue('');
  // × on the edge badge removes it.
  await page
    .getByRole('button', { name: 'Remove connection connection', exact: true })
    .click();
  await expect(connectionCount(page, 1)).toBeVisible();
  // × removes the operation; nothing in use is protected from removal.
  await page
    .getByRole('button', { name: 'Remove operation operation', exact: true })
    .click();
  await expect(operationNode(page, 'operation')).toHaveCount(0);
  for (const name of [
    'Remove connection primary',
    'Remove operation search',
    'Remove system Slow flight aggregator',
  ])
    await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
  // Dropping a connection drag on empty canvas spawns a connected system.
  const start = await settledBox(
    operationNode(page, 'find-options').locator('[data-handleid="plus-out"]'),
  );
  const bare = await emptySpot(page);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(bare.x, bare.y, { steps: 12 });
  await page.mouse.up();
  await expect(systemCount(page, 3)).toBeVisible();
  await expect(connectionCount(page, 2)).toBeVisible();
  await expect(page.getByRole('tab', { name: /^connection/ })).toContainText(
    'Flight-search agent → New system',
  );
  expect(errors).toEqual([]);
});
test('operations move between systems, into new ones, and refused moves say why', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.locator('.wf-canvas').scrollIntoViewIfNeeded();
  // Double-clicking inside a system adds an operation; on bare canvas, a system.
  const agent = (await systemGroup(page, 'Flight-search agent').boundingBox())!;
  await page.mouse.dblclick(
    agent.x + agent.width / 2,
    agent.y + agent.height - 6,
  );
  await expect(page.locator('#inspector')).toContainText(
    'On Flight-search agent',
  );
  const bare = await emptySpot(page);
  await page.mouse.dblclick(bare.x, bare.y);
  await expect(systemCount(page, 3)).toBeVisible();
  // Dropping on another system moves the operation, renamed where its ID is taken.
  await dragNode(
    page,
    operationNode(page, 'operation').first(),
    await centre(systemGroup(page, 'New system')),
    () =>
      expect(page.locator('.wf-hint')).toHaveText(
        'Release to move operation into New system.',
      ),
  );
  await expect(operationNode(page, 'operation-2')).toBeVisible();
  await expect(page.locator('#inspector')).toContainText('On New system');
  // Moving a system's last operation away leaves it empty, as a draft gap.
  await dragNode(page, operationNode(page, 'search'), 'empty', () =>
    expect(page.locator('.wf-hint')).toHaveText(
      'Release to give search a new system.',
    ),
  );
  await expect(systemCount(page, 4)).toBeVisible();
  await expect(systemGroup(page, 'Slow flight aggregator')).toContainText(
    'No operations yet.',
  );
  await expect(page.locator('.draft-gaps')).toContainText(
    'Give Slow flight aggregator an operation, or remove it.',
  );
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(systemCount(page, 3)).toBeVisible();
  await expect(page.locator('.draft-gaps')).toHaveCount(0);
  // A connected operation cannot join the system at its other end.
  await page
    .getByRole('button', { name: 'Connect operation-2', exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: '→ Slow flight aggregator · search' })
    .click();
  await expect(connectionCount(page, 2)).toBeVisible();
  await dragNode(
    page,
    operationNode(page, 'operation-2'),
    await centre(systemGroup(page, 'Slow flight aggregator')),
  );
  await expect(page.getByRole('alert')).toContainText(
    'It is connected to Slow flight aggregator, and a connection joins two different systems.',
  );
  await expect(page.locator('#inspector')).toContainText('On New system');
  // Dropping on bare canvas gives it a new system; its connection follows.
  await dragNode(page, operationNode(page, 'operation-2'), 'empty', () =>
    expect(page.locator('.wf-hint')).toHaveText(
      'Release to give operation-2 a new system.',
    ),
  );
  await expect(systemCount(page, 4)).toBeVisible();
  await expect(page.getByRole('tab', { name: /^connection/ })).toContainText(
    'New system → Slow flight aggregator',
  );
  await expect(
    page.locator('#inspector').getByRole('heading', { name: 'New system' }),
  ).toBeVisible();
  // The inspector moves an operation without dragging, and says when it cannot.
  await page
    .getByRole('button', { name: 'Operation operation-2', exact: true })
    .click();
  const system = page
    .locator('#inspector')
    .getByRole('combobox', { name: /^System/ });
  await system.selectOption({ label: 'Slow flight aggregator' });
  await expect(page.locator('#inspector-move')).toHaveText(
    'It is connected to Slow flight aggregator, and a connection joins two different systems.',
  );
  await system.selectOption({ label: 'Flight-search agent' });
  await expect(page.locator('#inspector')).toContainText(
    'On Flight-search agent',
  );
  await expect(page.locator('#inspector-move')).toHaveCount(0);
  await expect(connectionCount(page, 2)).toBeVisible();
  await expect(page.locator('.draft-gaps')).toContainText(
    'Give New system an operation, or remove it.',
  );
  expect(errors).toEqual([]);
});
test('a moved system keeps its place through edits; Re-layout and the map toggle recover', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.locator('.wf-canvas').scrollIntoViewIfNeeded();
  const group = systemGroup(page, 'Flight-search agent');
  const transform = () =>
    group.evaluate((el) => (el as HTMLElement).style.transform);
  // Drag the system by its header towards the lower middle of the canvas.
  const canvas = (await page.locator('.wf-canvas').boundingBox())!;
  const box = await settledBox(group);
  await page.mouse.move(box.x + box.width / 2, box.y + 14);
  await page.mouse.down();
  await page.mouse.move(
    canvas.x + canvas.width / 2,
    canvas.y + canvas.height - 80,
    { steps: 15 },
  );
  await page.mouse.up();
  const placed = await transform();
  expect(placed).not.toBe('');
  // Later edits lay out the rest of the graph around the hand-placed system.
  await page.getByRole('button', { name: '+ Add system' }).click();
  await settledBox(systemGroup(page, 'New system'));
  expect(await transform()).toBe(placed);
  // ↺ Re-layout returns it to the flow.
  await page.getByRole('button', { name: '↺ Re-layout' }).click();
  await expect.poll(transform).not.toBe(placed);
  // The overview map can be put away and brought back; Fit view reframes.
  await expect(page.locator('.react-flow__minimap')).toBeVisible();
  const map = page.getByRole('button', { name: 'Overview map' });
  await map.click();
  await expect(page.locator('.react-flow__minimap')).toHaveCount(0);
  await expect(map).toHaveAttribute('aria-pressed', 'false');
  await map.click();
  await expect(page.locator('.react-flow__minimap')).toBeVisible();
  await page.getByRole('button', { name: 'Fit view', exact: true }).click();
  await expect(operationNode(page, 'search')).toBeVisible();
  expect(errors).toEqual([]);
});
test('menus create at any level, and one operation fans out to many', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('.wf-canvas').scrollIntoViewIfNeeded();
  await expect(operationNode(page, 'search')).toBeVisible();
  const bare = await emptySpot(page);
  await page.mouse.click(bare.x, bare.y, { button: 'right' });
  const pane = page.getByRole('menu', { name: 'Workflow' });
  await expect(
    pane.getByRole('menuitem', { name: 'Add system' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(systemCount(page, 3)).toBeVisible();
  await page
    .getByRole('button', { name: 'System New system', exact: true })
    .click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'System New system' })
    .getByRole('menuitem', { name: 'Add operation' })
    .click();
  await expect(operationNode(page, 'operation-2')).toBeVisible();
  for (const [target, count] of [
    ['operation', 2],
    ['operation-2', 3],
  ] as const) {
    await page
      .getByRole('button', { name: 'Connect find-options', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: `→ New system · ${target}`, exact: true })
      .click();
    await expect(connectionCount(page, count)).toBeVisible();
  }
  await expect(operationNode(page, 'find-options')).toContainText('3 links');
  // Taken pairs drop out of the list; the reverse direction remains.
  await page
    .getByRole('button', { name: 'Connect find-options', exact: true })
    .click();
  const calls = page.getByRole('menu', { name: 'Connect find-options to' });
  await expect(calls.getByRole('menuitem')).toHaveText(['→ A new system']);
  await page.keyboard.press('Escape');
  await expect(calls).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Connect find-options', exact: true }),
  ).toBeFocused();
  await page
    .getByRole('button', {
      name: 'Connect a caller to find-options',
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole('menu', { name: 'Connect a caller to find-options' })
      .getByRole('menuitem'),
  ).toHaveText([
    '← Slow flight aggregator · search',
    '← New system · operation',
    '← New system · operation-2',
    '← A new system',
  ]);
  await page.keyboard.press('Escape');
  // The edge menu sets the latency target in place and opens its requirements.
  await page
    .getByRole('button', { name: 'Connection connection-2', exact: true })
    .click({ button: 'right' });
  const edge = page.getByRole('menu', { name: 'Connection connection-2' });
  await edge.getByRole('menuitem', { name: 'Set latency target' }).click();
  const latency = page.getByLabel('Latency target for connection-2 (ms)');
  await latency.fill('900');
  await latency.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Connection connection-2', exact: true }),
  ).toContainText('≤ 900 ms');
  await page
    .getByRole('button', {
      name: 'Edit requirements of connection',
      exact: true,
    })
    .click();
  await expect(page.locator('#inspector-experience')).toBeFocused();
  await expect(page.locator('#inspector')).toContainText(
    'Flight-search agent find-options → New system operation',
  );
  await expect(
    page.getByRole('tab', { name: /^connection\s/ }),
  ).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});
test('fullscreen editing with undo and redo, and Escape returns', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.locator('.wf-canvas').scrollIntoViewIfNeeded();
  await expect(operationNode(page, 'search')).toBeVisible();
  await page.getByRole('button', { name: '⤢ Fullscreen' }).click();
  const editor = page.getByRole('dialog', { name: 'Workflow editor' });
  await expect(editor).toBeVisible();
  await expect(page.locator('header')).toHaveJSProperty('inert', true);
  await expect
    .poll(async () => (await page.locator('.wf-canvas').boundingBox())!.height)
    .toBeGreaterThan(600);
  const canvas = (await page.locator('.wf-canvas').boundingBox())!;
  const inspector = (await page.locator('#inspector').boundingBox())!;
  expect(inspector.x).toBeGreaterThanOrEqual(canvas.x + canvas.width);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
  const bare = await emptySpot(page);
  await page.mouse.dblclick(bare.x, bare.y);
  await expect(systemCount(page, 3)).toBeVisible();
  await page.getByLabel('System name').fill('Seat map');
  await expect(
    page.getByRole('button', { name: 'System Seat map', exact: true }),
  ).toBeVisible();
  // Typing in one field is one step.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(
    page.getByRole('button', { name: 'System New system', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(systemCount(page, 2)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(systemCount(page, 3)).toBeVisible();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(
    page.getByRole('button', { name: 'System Seat map', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Redo' })).toBeDisabled();
  await page
    .getByRole('button', { name: 'Edit requirements of primary', exact: true })
    .click();
  await expect(page.locator('#inspector-experience')).toBeFocused();
  await expect(page.locator('#inspector-experience')).toBeInViewport();
  await page.screenshot({ path: 'test-results/plug-workflow-fullscreen.png' });
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(page.locator('header')).toHaveJSProperty('inert', false);
  await expect(
    page.getByRole('button', { name: 'System Seat map', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test('anything can be removed; a draft lists what it lacks until it is complete', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('.wf-canvas').scrollIntoViewIfNeeded();
  // An operation goes with its connections, and the canvas says so.
  await page
    .getByRole('button', { name: 'Remove operation search', exact: true })
    .click();
  await expect(operationNode(page, 'search')).toHaveCount(0);
  await expect(connectionCount(page, 0)).toBeVisible();
  await expect(page.locator('.wf-hint')).toHaveText(
    'Removed operation search and its 1 connection. Undo restores it.',
  );
  await expect(systemGroup(page, 'Slow flight aggregator')).toContainText(
    'No operations yet.',
  );
  const gaps = page.locator('.draft-gaps');
  await expect(gaps.getByRole('listitem')).toHaveText([
    'Give Slow flight aggregator an operation, or remove it.',
    'Connect an operation to an operation of another system.',
  ]);
  const suggest = page.getByRole('button', {
    name: 'Suggest design',
    exact: true,
  });
  await expect(suggest).toBeDisabled();
  await expect(suggest).toHaveAttribute(
    'title',
    /^Complete the workflow first: Give Slow flight aggregator/,
  );
  await expect(
    page.getByRole('button', { name: '↓ Download OpenSpec' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(connectionCount(page, 1)).toBeVisible();
  await expect(gaps).toHaveCount(0);
  await expect(suggest).toBeEnabled();
  // The last connection, and then every system, can go as well.
  await page
    .getByRole('button', { name: 'Remove connection primary', exact: true })
    .click();
  await expect(connectionCount(page, 0)).toBeVisible();
  for (const name of ['Slow flight aggregator', 'Flight-search agent'])
    await page
      .getByRole('button', { name: `Remove system ${name}`, exact: true })
      .click();
  await expect(systemCount(page, 0)).toBeVisible();
  await expect(page.locator('.wf-empty')).toBeVisible();
  await expect(gaps).toContainText('Add at least two systems.');
  const bare = await emptySpot(page);
  await page.mouse.dblclick(bare.x, bare.y);
  await expect(systemCount(page, 1)).toBeVisible();
  expect(errors).toEqual([]);
});
test('Add connection joins two clicked operations; a + shows on hover and Escape cancels', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: '+ Add system' }).click();
  await expect(operationNode(page, 'operation')).toBeVisible();
  await page.locator('.wf-canvas').scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const plus = operationNode(page, 'find-options').locator(
    '[data-handleid="plus-out"]',
  );
  await expect(plus).toHaveCSS('opacity', '0');
  await page
    .getByRole('button', { name: 'Operation find-options', exact: true })
    .hover();
  await expect(plus).toHaveCSS('opacity', '1');
  const add = page.getByRole('button', { name: '+ Add connection' });
  const hint = page.locator('.wf-hint');
  await add.click();
  await expect(add).toHaveAttribute('aria-pressed', 'true');
  await expect(hint).toHaveText(
    'Click the operation that makes the call, or the + on either side of an operation. Esc cancels.',
  );
  await page.keyboard.press('Escape');
  await expect(add).toHaveAttribute('aria-pressed', 'false');
  await expect(hint).toHaveCount(0);
  // Pick the caller, then the operation it calls; a taken pair says why not.
  await add.click();
  await page
    .getByRole('button', { name: 'Operation find-options', exact: true })
    .click();
  await expect(hint).toHaveText(
    'Click the operation find-options calls. Click find-options again to start over; Esc cancels.',
  );
  const card = (id: string) => operationNode(page, id).locator('.wf-operation');
  await expect(card('find-options')).toHaveClass(/mark-origin/);
  await expect(card('search')).toHaveClass(/mark-invalid/);
  await expect(card('operation')).toHaveClass(/mark-valid/);
  await page
    .getByRole('button', { name: 'Operation search', exact: true })
    .hover();
  await expect(hint).toHaveText('These operations are already connected.');
  await page
    .getByRole('button', { name: 'Operation operation', exact: true })
    .click();
  await expect(add).toHaveAttribute('aria-pressed', 'false');
  await expect(connectionCount(page, 2)).toBeVisible();
  await expect(page.getByRole('tab', { name: /^connection/ })).toContainText(
    'Flight-search agent → New system',
  );
  // The + before an operation picks it as the one being called.
  await add.click();
  await page
    .getByRole('button', { name: 'Connect a caller to operation', exact: true })
    .click();
  await expect(hint).toHaveText(
    'Click the operation that calls operation. Click operation again to start over; Esc cancels.',
  );
  await page
    .getByRole('button', { name: 'Operation search', exact: true })
    .click();
  await expect(connectionCount(page, 3)).toBeVisible();
  await expect(page.getByRole('tab', { name: /^connection-2/ })).toContainText(
    'Slow flight aggregator → New system',
  );
  expect(errors).toEqual([]);
});
test('MCP and A2A systems take server details; the hosted playground never contacts them', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const discoveries: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/discover')) discoveries.push(r.url());
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'System Slow flight aggregator', exact: true })
    .click();
  const inspector = page.locator('#inspector');
  const protocol = inspector.getByLabel('Protocol');
  await protocol.selectOption('mcp');
  const server = inspector.getByRole('region', { name: 'MCP server' });
  await expect(server).toContainText('Discovery runs in the local workbench');
  await expect(server.getByRole('button')).toHaveCount(0);
  await expect(server.getByLabel(/^Request headers/)).toHaveCount(0);
  // The endpoint is kept without credentials or a query string.
  const endpoint = server.getByLabel('Streamable HTTP endpoint');
  await endpoint.fill('https://user:pw@tools.example.com/mcp?key=secret');
  await endpoint.blur();
  const json = page.getByLabel('Design input');
  await expect(json).toHaveValue(
    /"endpoint": "https:\/\/tools\.example\.com\/mcp"/,
  );
  await expect(json).not.toHaveValue(/secret|user:pw/);
  await protocol.selectOption('a2a');
  await expect(
    inspector.getByRole('region', { name: 'A2A agent' }),
  ).toContainText('Discovery runs in the local workbench');
  // Only a system that exposes the protocol has a server to list.
  await inspector.getByLabel('Direction').selectOption('calls');
  await expect(
    inspector.getByRole('region', { name: 'A2A agent' }),
  ).toHaveCount(0);
  await expect(inspector).toContainText(
    "Set Direction to Exposes to enter this server's details",
  );
  expect(discoveries).toEqual([]);
  expect(errors).toEqual([]);
});
test('the inspector declares workload, path, trust, channel and mapping facts', async ({
  page,
}) => {
  await page.goto('/');
  const inspector = page.locator('#inspector');
  const json = page.getByLabel('Design input');
  // Connection facts: workload, downstream profile and the caller path.
  await inspector.getByLabel('Requests / minute', { exact: true }).fill('120');
  await expect(json).toHaveValue(/"requestsPerMinute": \{\s*"value": 120/);
  await inspector
    .getByLabel('Availability (0–1)', { exact: true })
    .fill('0.999');
  await expect(json).toHaveValue(/"availability": \{\s*"value": 0\.999/);
  await inspector.getByLabel('Final deadline (ms)').fill('8000');
  await expect(json).toHaveValue(/"finalDeadlineMs": 8000/);
  await inspector.getByLabel('Network (ms)').fill('40');
  await expect(json).toHaveValue(/"networkMs": \{\s*"value": 40/);
  await inspector
    .getByLabel('Source timestamp')
    .selectOption('responseSnapshot');
  await expect(json).toHaveValue(/"sourceTimestamp": "responseSnapshot"/);
  // Mappings cover the structured contracts row by row.
  await inspector.getByRole('button', { name: '+ Add input mapping' }).click();
  const rows = inspector.locator('.mapping-editor').first().locator('li');
  const added = rows.nth((await rows.count()) - 1);
  await added.getByLabel(/from$/).fill('origin');
  await added.getByLabel(/to$/).fill('query');
  await expect(json).toHaveValue(/"from": "origin",\s*"to": "query"/);
  // Shared infrastructure numbers.
  await inspector.getByLabel('Cache capacity (entries)').fill('50000');
  await expect(json).toHaveValue(/"cacheCapacity": 50000/);
  // System facts: trust domain, channel semantics, and an OpenAPI panel.
  await page
    .getByRole('button', { name: 'System Slow flight aggregator', exact: true })
    .click();
  await inspector.getByLabel('Trust domain').fill('vendor');
  await expect(json).toHaveValue(/"trustDomain": "vendor"/);
  await expect(
    inspector.getByRole('region', { name: 'OpenAPI service' }),
  ).toContainText('Discovery runs in the local workbench');
  await inspector.getByLabel('Delivery').selectOption('at-least-once');
  await inspector.getByLabel('Channel ordering').selectOption('key');
  await expect(json).toHaveValue(/"delivery": "at-least-once"/);
  await expect(json).toHaveValue(/"ordering": "key"/);
  // Operation semantics the relation facts need.
  await operationNode(page, 'search').click();
  await inspector.getByLabel('Output meaning').fill('Fare snapshot');
  await expect(json).toHaveValue(/"outputMeaning": "Fare snapshot"/);
  await inspector.getByLabel('Sharing scope').selectOption('tenant');
  await expect(json).toHaveValue(/"scope": "tenant"/);
  await inspector.getByLabel('Accepts idempotency key').selectOption('true');
  await expect(json).toHaveValue(/"idempotencyKeySupported": true/);
  await inspector
    .getByLabel('Key dimensions · comma separated')
    .fill('origin, destination');
  await expect(json).toHaveValue(
    /"keyDimensions": \[\s*"origin",\s*"destination"\s*\]/,
  );
});
test('an edge lists the facts it still needs; judgment points to the workbench', async ({
  page,
}) => {
  await page.goto('/');
  const inspector = page.locator('#inspector');
  const needed = inspector.getByRole('list', { name: 'Facts still needed' });
  await expect(
    needed.getByText('Availability target', { exact: true }),
  ).toBeVisible();
  await expect(
    needed.getByText('Downstream availability', { exact: true }),
  ).toBeVisible();
  // Declaring the fact clears its entry; nothing is ever filled in for you.
  await inspector.getByLabel('Availability target (0–1)').fill('0.999');
  await expect(
    needed.getByText('Availability target', { exact: true }),
  ).toHaveCount(0);
  await expect(
    needed.getByText('Downstream availability', { exact: true }),
  ).toBeVisible();
  // Differing semantic texts: the hosted playground never judges them itself.
  await inspector
    .getByLabel('Useful initial output')
    .fill('indicative fare options');
  await expect(inspector.locator('.judge-row')).toContainText(
    'Judgment runs in the local workbench',
  );
});
test.describe('local workbench', () => {
  test.use({ baseURL: process.env.PLUG_WORKBENCH_URL });
  test('writes the spec bundle for the IDE and reopens agent edits', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#workspace')).toBeVisible();
    await page.getByRole('button', { name: 'Write spec to workspace' }).click();
    await expect(page.getByText(/Wrote .plug\/workflow.yaml/)).toBeVisible();
    const file = join(
      process.env.PLUG_WORKBENCH_DIR!,
      '.plug',
      'workflow.yaml',
    );
    const written = readFileSync(file, 'utf8');
    const at = written.lastIndexOf('latencyTargetMs: 2000');
    expect(at).toBeGreaterThan(0);
    writeFileSync(
      file,
      written.slice(0, at) +
        'latencyTargetMs: 2500' +
        written.slice(at + 'latencyTargetMs: 2000'.length),
    );
    await page.reload();
    await expect(
      page.getByText(/changed since Plug last wrote it/),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open workspace spec' }).click();
    const review = page.getByRole('region', { name: 'Workflow import review' });
    await expect(review).toContainText('Review .plug/workflow.yaml');
    await review.getByRole('button', { name: 'Replace workflow' }).click();
    await expect(page.getByLabel('Latency target (ms)')).toHaveValue('2500');
    await page.screenshot({ path: 'test-results/plug-workbench.png' });
  });
  test('reviews, adopts, and clears an engine-admissible architecture', async ({
    page,
  }) => {
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Suggest design', exact: true })
      .click();
    const review = page.getByRole('region', { name: 'Design review' });
    await review
      .getByRole('button', { name: 'Review selected designs' })
      .click();
    await expect(review).toContainText('Critic stub-reviewer');
    const adopt = review.getByRole('button', { name: /^Adopt / }).first();
    await expect(adopt).toBeVisible();
    await adopt.click();
    await expect(page.getByText(/Author adoption: honored\./)).toBeVisible();
    await page.getByRole('button', { name: 'Clear adoption' }).click();
    await expect(page.getByText(/Author adoption:/)).toHaveCount(0);
    await expect(
      page.getByText(
        'Cleared the author adoption and restored the engine selection.',
      ),
    ).toBeVisible();
  });
  test('restores a retained spec through review, replace, and write', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Write spec to workspace' }).click();
    await page.getByLabel('Latency target (ms)').fill('1777');
    await page.getByRole('button', { name: 'Write spec to workspace' }).click();
    const history = page.locator('.spec-history');
    await history.getByText('Spec history').click();
    const revisions = history.locator('h3', { hasText: 'Plug revisions' });
    await expect(revisions).toBeVisible();
    const revisionButtons = history.locator('ul').first().getByRole('button');
    expect(await revisionButtons.count()).toBeGreaterThanOrEqual(2);
    await revisionButtons.last().click();
    const review = page.getByRole('region', { name: 'Workflow import review' });
    await expect(review).toContainText('Plug revision');
    await review.getByRole('button', { name: 'Replace workflow' }).click();
    await expect(page.getByLabel('Latency target (ms)')).toHaveValue('2000');
    await page.getByRole('button', { name: 'Write spec to workspace' }).click();
    await expect(page.getByText(/Wrote .plug\/workflow.yaml/)).toBeVisible();
  });
  test('verifies an authorized plain-REST edge from the workbench', async ({
    page,
  }) => {
    const api = await startRoutes({
      '/offers': {
        json: {
          capturedAt: new Date().toISOString(),
          payload: {
            offers: [{ id: 'fare-1', price: 125, currency: 'USD' }],
          },
        },
      },
    });
    try {
      const input = flightInput();
      input.systems[1].interfaces[0].endpoint = api.origin;
      input.systems[1].operations[0].binding = {
        request: {
          protocol: 'http',
          method: 'GET',
          pathTemplate: '/offers',
          query: { origin: '{origin}' },
          headers: {},
          bodyTemplate: null,
          samples: keys,
          samplesEvidence: synthetic,
        },
        response: {
          dataPointer: '/payload',
          snapshotPointer: '/capturedAt',
          snapshotHeader: null,
          timestampFormat: 'iso-8601',
        },
      };
      const authorized = await page.request.post(
        `${process.env.PLUG_WORKBENCH_URL}/api/probe`,
        {
          data: {
            input,
            systemId: 'aggregator',
            authorize: true,
            inspect: false,
          },
        },
      );
      expect(authorized.ok()).toBe(true);
      await page.goto('/');
      await page.getByText('Advanced input · JSON / YAML').click();
      await page.getByLabel('Design input').fill(JSON.stringify(input));
      await page.getByRole('button', { name: 'Apply document' }).click();
      await page
        .getByRole('button', { name: 'Suggest design', exact: true })
        .click();
      await page.getByRole('button', { name: 'Verify as-is' }).click();
      const demonstration = page
        .getByText('Demonstration', { exact: true })
        .locator('..');
      await expect(demonstration).not.toContainText('Not run');
      await expect(demonstration).toContainText(
        'Workbench vantage only; this is not a production SLO.',
      );
      expect(
        api.requests.filter((request) => request.method === 'GET'),
      ).toHaveLength(3);
    } finally {
      await api.close();
    }
  });
  test('lists MCP tools and A2A skills without keeping discovery headers', async ({
    page,
  }) => {
    const mcp = await startMcpFixture({
      tools: [
        ...fixtureTools(9),
        { name: 'no_schema', description: 'Declares no input schema' },
      ],
      pageSize: 4,
      require: ['Authorization', 'Bearer e2e'],
      serverInfo: { name: 'fares', version: '2.0.0', title: 'Fares MCP' },
    });
    const agent = await startRoutes({
      '/.well-known/agent-card.json': {
        json: {
          name: 'Travel agent',
          description: 'Books trips',
          supportedInterfaces: [
            {
              url: 'https://agent.test/a2a',
              protocolVersion: '1.0',
              protocolBinding: 'JSONRPC',
            },
          ],
          capabilities: {},
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [
            { id: 'plan', name: 'Plan', description: 'Plan a trip' },
            { id: 'rebook', name: 'Rebook', description: 'Rebook a flight' },
          ],
        },
      },
    });
    try {
      await page.goto('/');
      await expect(page.locator('#workspace')).toBeVisible();
      const inspector = page.locator('#inspector');
      const json = page.getByLabel('Design input');
      await page.getByRole('button', { name: '+ Add system' }).click();
      await addWithoutInspection(page);
      await inspector.getByLabel('Protocol').selectOption('mcp');
      const server = inspector.getByRole('region', { name: 'MCP server' });
      await server
        .getByLabel('Streamable HTTP endpoint')
        .fill(`${mcp.url}?tenant=e2e`);
      const discover = server.getByRole('button', { name: 'Discover tools' });
      await discover.click();
      await expect(server.getByRole('alert')).toContainText(
        'refused the request (HTTP 401)',
      );
      await server
        .getByLabel(/^Request headers/)
        .fill('Authorization: Bearer e2e');
      await discover.click();
      const tools = server.getByRole('group', {
        name: 'Fares MCP · MCP 2025-11-25 · 10 tools',
      });
      await expect(tools).toContainText('9 chosen');
      await expect(
        tools.getByRole('checkbox', { name: /^no_schema/ }),
      ).toBeDisabled();
      const filter = tools.getByLabel('Filter tools');
      await filter.fill('tool_2');
      await expect(tools.getByRole('checkbox')).toHaveCount(1);
      await expect(
        tools.getByRole('checkbox', { name: /^tool_2 / }),
      ).toBeChecked();
      await filter.fill('');
      await expect(
        tools.getByRole('checkbox', { name: /^tool_5 / }),
      ).toBeChecked();
      await expect(tools).toContainText('Applying removes operation.');
      await tools.getByRole('button', { name: 'Apply to New system' }).click();
      await addWithoutInspection(page);
      await expect(server.getByRole('status')).toContainText(
        'Fares MCP now has 9 tools from the server.',
      );
      await expect(operationNode(page, 'tool_2')).toBeVisible();
      await expect(operationNode(page, 'tool_5')).toBeVisible();
      await expect(operationNode(page, 'tool_9')).toBeVisible();
      await expect(operationNode(page, 'operation')).toHaveCount(0);
      // Plug lists tools and never calls one; the query is used, not kept.
      const rpcs = mcp.requests.flatMap((r) => (r.rpc ? [r.rpc] : []));
      expect(rpcs.filter((m) => m === 'tools/list')).toHaveLength(3);
      expect(rpcs).not.toContain('tools/call');
      expect(mcp.requests.at(-1)!.path).toContain('tenant=e2e');
      await expect(json).toHaveValue(
        new RegExp(`"endpoint": "${mcp.url.replaceAll('.', '\\.')}"`),
      );
      await expect(json).not.toHaveValue(/Bearer e2e|tenant=e2e/);
      // An A2A agent's skills come from its public Agent Card.
      await page.getByRole('button', { name: '+ Add system' }).click();
      await addWithoutInspection(page);
      await inspector.getByLabel('Protocol').selectOption('a2a');
      const card = inspector.getByRole('region', { name: 'A2A agent' });
      await card.getByLabel('Agent URL or Agent Card URL').fill(agent.origin);
      await card.getByRole('button', { name: 'Discover skills' }).click();
      const skills = card.getByRole('group', {
        name: 'Travel agent · Agent Card · 2 skills',
      });
      await expect(
        skills.getByRole('checkbox', { name: /^plan/ }),
      ).toBeChecked();
      await expect(
        skills.getByRole('checkbox', { name: /^rebook/ }),
      ).toBeChecked();
      await skills.getByRole('button', { name: 'Apply to New system' }).click();
      await addWithoutInspection(page);
      await expect(operationNode(page, 'rebook')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'System Travel agent', exact: true }),
      ).toBeVisible();
      expect(agent.requests.map((r) => r.method)).toEqual(['GET']);
    } finally {
      await Promise.all([mcp.close(), agent.close()]);
    }
  });
  test('lists an OpenAPI service and inspects only its authorized safe read', async ({
    page,
  }) => {
    const api = await startRoutes({
      '/openapi.json': {
        require: ['Authorization', 'Bearer api'],
        json: {
          openapi: '3.1.0',
          info: { title: 'Inventory API', version: '1.0.0' },
          components: {
            securitySchemes: {
              ApiKey: {
                type: 'apiKey',
                in: 'header',
                name: 'X-Api-Key',
              },
            },
          },
          security: [{ ApiKey: [] }],
          paths: {
            '/availability/{sku}': {
              get: {
                operationId: 'check-availability',
                summary: 'Availability snapshot',
                parameters: [
                  {
                    name: 'sku',
                    in: 'path',
                    required: true,
                    schema: { type: 'string', enum: ['SKU-1'] },
                  },
                ],
                responses: {
                  '200': {
                    content: {
                      'application/json': {
                        schema: {
                          type: 'object',
                          properties: { available: { type: 'integer' } },
                        },
                      },
                    },
                  },
                },
              },
            },
            '/reservations': {
              post: {
                operationId: 'reserve-stock',
                parameters: [
                  {
                    name: 'Idempotency-Key',
                    in: 'header',
                    required: true,
                    schema: { type: 'string' },
                  },
                ],
                responses: { '201': { description: 'created' } },
              },
            },
          },
        },
      },
      '/availability/SKU-1': {
        json: { available: 7 },
      },
    });
    try {
      await page.goto('/');
      const inspector = page.locator('#inspector');
      const json = page.getByLabel('Design input');
      await page.getByRole('button', { name: '+ Add system' }).click();
      await addWithoutInspection(page);
      // A new system exposes HTTP, so the OpenAPI panel is already there, and
      // indexing comes first: the fresh system starts at its document URL.
      const server = inspector.getByRole('region', { name: 'OpenAPI service' });
      const url = server.getByLabel('OpenAPI document URL');
      await expect(url).toBeFocused();
      await url.fill(`${api.url}/openapi.json?draft=1`);
      await url.press('Enter');
      await expect(server.getByRole('alert')).toContainText(
        'refused the request (HTTP 401)',
      );
      await server
        .getByLabel(/^Request headers/)
        .fill('Authorization: Bearer api');
      await server.getByRole('button', { name: 'Discover operations' }).click();
      const ops = server.getByRole('group', {
        name: 'Inventory API · OpenAPI 3.1.0 · 2 operations',
      });
      await expect(ops).toContainText(/Listed in \d+ ms by this workbench/);
      await expect(
        ops.getByRole('checkbox', { name: /^check-availability/ }),
      ).toBeChecked();
      await expect(ops).toContainText('GET /availability/{sku}');
      await ops.getByRole('checkbox', { name: /^reserve-stock/ }).check();
      await ops.getByRole('button', { name: 'Apply to New system' }).click();
      const disclosure = page.getByRole('dialog', {
        name: 'Add integration host?',
      });
      await expect(operationNode(page, 'check-availability')).toHaveCount(0);
      await disclosure.getByRole('button', { name: 'Add and inspect' }).click();
      await expect(disclosure).toHaveCount(0);
      await expect(server.getByRole('status')).toContainText(
        'Inventory API now has 2 operations from the server.',
      );
      await expect(operationNode(page, 'check-availability')).toBeVisible();
      await expect(operationNode(page, 'reserve-stock')).toBeVisible();
      await page
        .getByRole('button', {
          name: 'Operation check-availability',
          exact: true,
        })
        .click();
      await expect(inspector.getByLabel('Method')).toHaveValue('GET');
      await expect(inspector.getByLabel('Path template')).toHaveValue(
        '/availability/{sku}',
      );
      await expect(inspector.getByLabel('Header template JSON')).toHaveValue(
        /\$\{env:X_API_KEY\}/,
      );
      await inspector
        .getByLabel('Header template JSON')
        .fill('{"Authorization":"Bearer leaked"}');
      await inspector
        .getByRole('button', { name: /Apply header template JSON/i })
        .click();
      await expect(inspector.getByRole('alert')).toContainText(
        'save an environment reference',
      );
      await expect(json).not.toHaveValue(/Bearer leaked/);
      await expect(inspector.getByLabel('Response data pointer')).toHaveValue(
        'root',
      );
      // The endpoint defaults to the document origin; the method and path
      // stay with each operation; discovery credentials and URL query are never kept.
      await expect(json).toHaveValue(
        new RegExp(`"endpoint": "${api.origin.replaceAll('.', '\\.')}/"`),
      );
      await expect(json).toHaveValue(/"idempotencyKeySupported": true/);
      await expect(json).toHaveValue(/"path": "\/reservations"/);
      await expect(json).not.toHaveValue(/Bearer api|draft=1/);
      await expect(
        page
          .getByRole('region', { name: 'Probe manifest' })
          .getByText(/samples · \d+ ms window/),
      ).toBeVisible();
      expect(
        api.requests.filter((request) =>
          request.path.startsWith('/availability/SKU-1'),
        ),
      ).toHaveLength(3);
      expect(
        api.requests.filter((request) =>
          request.path.startsWith('/reservations'),
        ),
      ).toHaveLength(0);
    } finally {
      await api.close();
    }
  });
  test('judges differing texts with the configured stub and pins the verdict', async ({
    page,
  }) => {
    await page.goto('/');
    const inspector = page.locator('#inspector');
    const json = page.getByLabel('Design input');
    const row = inspector.locator('.judge-row');
    // Same tokens, different phrasing: the strict comparison alone fails.
    await inspector
      .getByLabel('Useful initial output')
      .fill('the flight options, indicative');
    await expect(row).toContainText('strict comparison fails');
    await row.getByRole('button', { name: 'Judge equivalence' }).click();
    await expect(row).toContainText('Judged equivalent');
    await expect(row).toContainText('stub:');
    await expect(json).toHaveValue(/"semanticEquivalence": \{/);
    await expect(json).toHaveValue(/"kind": "judged"/);
    // The verdict is pinned to its exact strings: editing one voids it.
    await inspector.getByLabel('Useful initial output').fill('fare options');
    await expect(row).toContainText('no longer applies');
    await row.getByRole('button', { name: 'Clear judgment' }).click();
    await expect(json).not.toHaveValue(/semanticEquivalence/);
    await expect(row).toContainText('strict comparison fails');
  });
  test('drafts missing facts for review and adopts only on author action', async ({
    page,
  }) => {
    await page.goto('/');
    const json = page.getByLabel('Design input');
    await page
      .getByRole('button', { name: 'Operation search', exact: true })
      .click();
    await page.getByLabel('Output meaning').fill('');
    await page
      .getByRole('button', { name: 'Connection primary', exact: true })
      .click();
    const needed = page
      .locator('#inspector')
      .getByRole('list', { name: 'Facts still needed' });
    await expect(
      needed.getByText('Downstream output meaning', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Draft missing facts' }).click();
    const proposals = page.getByRole('region', {
      name: 'Draft fact proposals',
    });
    await expect(proposals).toContainText('stub-drafter');
    await expect(proposals).toContainText('Read a timestamped fare snapshot');
    // Drafting is review-only: the canonical input is still unknown.
    await expect(json).toHaveValue(/"outputMeaning": null/);
    await proposals
      .getByRole('button', {
        name: 'Adopt Downstream output meaning',
      })
      .click();
    await expect(json).toHaveValue(
      /"outputMeaning": "Read a timestamped fare snapshot"/,
    );
    await expect(json).toHaveValue(/"type": "model-draft"/);
    await expect(json).toHaveValue(
      /Supporting quote.*Read a timestamped fare snapshot/,
    );
    await expect(json).toHaveValue(/Jev cross-check was not configured/);
    await expect(
      needed.getByText('Downstream output meaning', { exact: true }),
    ).toHaveCount(0);
    // Adoption uses the normal editor transaction and is undoable.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(json).toHaveValue(/"outputMeaning": null/);
  });

  test('large workflow keeps fifty operations and one hundred searchable connections', async ({
    page,
  }) => {
    const input = flightInput();
    const caller = input.systems[0].operations[0];
    const downstream = input.systems[1].operations[0];
    input.systems[0].operations = Array.from({ length: 25 }, (_, index) => ({
      ...structuredClone(caller),
      id: `caller-${index + 1}`,
    }));
    input.systems[1].operations = Array.from({ length: 25 }, (_, index) => ({
      ...structuredClone(downstream),
      id: `downstream-${index + 1}`,
    }));
    const template = input.connections[0];
    input.connections = Array.from({ length: 100 }, (_, index) => {
      const callerIndex = index % 25;
      const downstreamIndex = Math.floor(index / 25);
      return {
        ...structuredClone(template),
        id: `edge-${index + 1}`,
        callerOperationId: `caller-${callerIndex + 1}`,
        downstreamOperationId: `downstream-${downstreamIndex + 1}`,
        profile: {
          ...structuredClone(template.profile),
          operationId: `downstream-${downstreamIndex + 1}`,
        },
      };
    });
    await page.goto('/');
    await page.getByText('Advanced input · JSON / YAML').click();
    await page.getByLabel('Design input').fill(JSON.stringify(input));
    const started = Date.now();
    await page.getByRole('button', { name: 'Apply document' }).click();
    await expect(page.getByText('2 systems · 100 connections')).toBeVisible();
    await expect(page.getByLabel('Find a connection')).toBeVisible();
    await page.getByLabel('Find a connection').fill('edge-100');
    await expect(page.getByRole('tab', { name: /edge-100/ })).toBeVisible();
    await expect(page.locator('.react-flow__node-operation')).toHaveCount(50);
    expect(Date.now() - started).toBeLessThan(10_000);
    await page
      .getByRole('button', { name: 'Suggest design', exact: true })
      .click();
    await expect(
      page.getByText('Flight-search agent · 100', { exact: true }),
    ).toBeVisible();
  });
});
