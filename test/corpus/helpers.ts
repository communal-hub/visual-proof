import fs from 'node:fs';
import type { FinishResult } from '../../src/finish.js';
import type { FrameEvent } from '../../src/watch.js';

export const DETAIL = 'src/pages/InvoiceDetail.vue';
export const REPORTS = 'src/pages/Reports.vue';
export const HOME = 'src/pages/Home.vue';
export const DATA = 'server/data.json';

export const DETAIL_ROUTE = '/manage/invoices/1';
export const REPORTS_ROUTE = '/reports';

/** Swap the first `<h1>` for `text`; every fixture page has exactly one. */
export const setHeading =
  (text: string) =>
  (source: string): string =>
    source.replace(/<h1>[^<]*<\/h1>/, `<h1>${text}</h1>`);

/** Make the page throw while its component sets up (Vue logs it as a console error). */
export const breakSetup = (source: string): string =>
  source.replace('<script setup>', "<script setup>\nthrow new Error('corpus: broken final save')");

export const forRoute = (route: string, extra: (e: FrameEvent) => boolean = () => true) => (e: FrameEvent) =>
  e.frame.route === route && extra(e);

export const readBlock = (result: FinishResult): string => fs.readFileSync(result.proofBlockPath, 'utf8');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
