import type { PatternId } from '../contracts/index';
export const catalogVersion = '0.1-alpha.2/catalog-1';
export const catalog: { id: PatternId; title: string; components: string[] }[] =
  [
    { id: 'direct', title: 'Direct request', components: [] },
    {
      id: 'cache-aside',
      title: 'Cache-aside',
      components: ['Exact-key cache'],
    },
    {
      id: 'scheduled-cache',
      title: 'Scheduled refresh + cache',
      components: ['Exact-key cache', 'Refresh scheduler'],
    },
    {
      id: 'progressive',
      title: 'Useful initial output + deferred live result',
      components: ['Progressive delivery'],
    },
    {
      id: 'scheduled-cache-aside',
      title: 'Scheduled cache + miss filling',
      components: ['Exact-key cache', 'Refresh scheduler', 'Miss filling'],
    },
    {
      id: 'cached-live',
      title: 'Cached initial output + live refresh',
      components: ['Exact-key cache', 'Progressive delivery'],
    },
  ];
export const intervals = [
  1000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000,
];
export const cached = (id: PatternId) =>
  !['direct', 'progressive'].includes(id);
export const scheduled = (id: PatternId) => id.startsWith('scheduled-');
