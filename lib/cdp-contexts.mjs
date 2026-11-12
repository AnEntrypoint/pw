import { chromium } from '@xmorse/playwright-core';

const connectOverCDP = chromium.connectOverCDP.bind(chromium);

chromium.connectOverCDP = async (...args) => {
  const browser = await connectOverCDP(...args);
  const until = Date.now() + 15000;
  while (browser.contexts().length === 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return browser;
};
